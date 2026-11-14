package com.ludy.flotte;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Alertes des pauses et des courses suivies, même écran éteint (Ludy 1.3, 14/11/2026, demande d'Ahmed).
 * Service au premier plan (notification permanente « Ludy surveille les pauses ») qui interroge la base toutes les 30 s
 * avec le secret du téléphone (watch_poll ; jamais le jeton du site, qui expire quand l'application dort). Tant qu'une pause
 * ou une course est suivie, le relais geotab-live (?mode=watch) relit aussi les positions Geotab toutes les 60 s.
 * Notifications (son, vibration, écran allumé) : rappel toutes les 30 min, fin de pause (puis toutes les 5 min tant qu'elle n'est
 * pas terminée), véhicule en pause qui bouge (puis toutes les 2 min tant qu'il n'est pas revenu à sa place, sauf
 * « Déplacement autorisé »), course arrivée à destination. Appui sur la notification = page Pauses de Ludy.
 */
public class WatchService extends Service {
  static final String PREFS = "watch", CH_ALERT = "ludy_alertes", CH_RUN = "ludy_surveillance";
  static final String ACTION_ALLOW = "com.ludy.flotte.ALLOW", ACTION_STOP = "com.ludy.flotte.STOP";
  static final int RUN_ID = 1;
  static final long POLL_MS = 30000, GEO_MS = 60000, END_EVERY = 5 * 60000, MOVE_EVERY = 2 * 60000;
  volatile boolean running;
  Thread loop;
  PowerManager.WakeLock wake;
  long lastGeo;
  final Map<String, Long> sent = new HashMap<>();
  final Set<String> allowed = new HashSet<>();
  final Map<String, Boolean> away = new HashMap<>();   // dernier constat du relais : véhicule encore loin de sa place ?

  static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
  static boolean enabled(Context c) { SharedPreferences p = prefs(c); return p.getBoolean("on", false) && !p.getString("secret", "").isEmpty(); }

  static void start(Context c) {
    Intent i = new Intent(c, WatchService.class);
    if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
  }

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public void onCreate() {
    super.onCreate();
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel run = new NotificationChannel(CH_RUN, "Surveillance des pauses", NotificationManager.IMPORTANCE_LOW);
      run.setDescription("Notification permanente tant que Ludy surveille les pauses");
      nm.createNotificationChannel(run);
      NotificationChannel al = new NotificationChannel(CH_ALERT, "Alertes pauses et courses", NotificationManager.IMPORTANCE_HIGH);
      al.setDescription("Fin de pause, véhicule en pause qui bouge, course arrivée");
      al.enableVibration(true);
      al.setVibrationPattern(new long[] { 0, 600, 250, 600, 250, 900 });
      al.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
          new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
      al.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
      nm.createNotificationChannel(al);
    }
    for (String s : prefs(this).getStringSet("allowed", new HashSet<>())) allowed.add(s);
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    String act = intent == null ? null : intent.getAction();
    if (ACTION_ALLOW.equals(act)) {
      String id = intent.getStringExtra("id");
      if (id != null) { allowed.add(id); prefs(this).edit().putStringSet("allowed", new HashSet<>(allowed)).apply(); getSystemService(NotificationManager.class).cancel(("m|" + id).hashCode()); }
    }
    if (ACTION_STOP.equals(act) || !enabled(this)) { foreground("Surveillance arrêtée"); stopSelf(); return START_NOT_STICKY; }
    foreground("Démarrage…");
    if (!running) {
      running = true;
      PowerManager pm = getSystemService(PowerManager.class);
      wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ludy:surveillance");
      wake.setReferenceCounted(false);
      wake.acquire();
      loop = new Thread(this::run, "ludy-surveillance");
      loop.start();
    }
    return START_STICKY;
  }

  @Override public void onDestroy() {
    running = false;
    if (loop != null) loop.interrupt();
    if (wake != null && wake.isHeld()) wake.release();
    super.onDestroy();
  }

  PendingIntent openApp(String hash, int code) {
    Intent i = new Intent(this, MainActivity.class).putExtra("hash", hash).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  Notification.Builder builder(String ch) {
    return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, ch) : new Notification.Builder(this);
  }

  void foreground(String text) {
    Notification n = builder(CH_RUN).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle("Ludy surveille les pauses")
        .setContentText(text).setOngoing(true).setContentIntent(openApp("#/suivi", 0)).build();
    if (Build.VERSION.SDK_INT >= 29) startForeground(RUN_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    else startForeground(RUN_ID, n);
  }

  void alert(String key, String title, String text, String allowId) {
    Notification.Builder b = builder(CH_ALERT).setSmallIcon(android.R.drawable.stat_notify_error).setContentTitle(title).setContentText(text)
        .setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(openApp("#/suivi", key.hashCode()))
        .setCategory(Notification.CATEGORY_ALARM).setVisibility(Notification.VISIBILITY_PUBLIC);
    if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_MAX).setDefaults(Notification.DEFAULT_ALL);
    if (allowId != null) {
      Intent i = new Intent(this, WatchService.class).setAction(ACTION_ALLOW).putExtra("id", allowId);
      PendingIntent pi = Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(this, ("a|" + allowId).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
          : PendingIntent.getService(this, ("a|" + allowId).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
      b.addAction(new Notification.Action.Builder(null, "Déplacement autorisé", pi).build());
    }
    getSystemService(NotificationManager.class).notify(key.split("@")[0].hashCode(), b.build());
    // écran allumé quelques secondes (alerte vue sur un téléphone posé)
    try { PowerManager pm = getSystemService(PowerManager.class);
      @SuppressWarnings("deprecation") PowerManager.WakeLock w = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "ludy:alerte");
      w.acquire(5000); } catch (Exception e) { }
  }

  /** Envoie une notification une seule fois par clé (clé avec « @n » : une fois par tranche de temps) */
  boolean once(String key) {
    if (sent.containsKey(key)) return false;
    sent.put(key, System.currentTimeMillis());
    if (sent.size() > 400) { long lim = System.currentTimeMillis() - 48 * 3600000L; Iterator<Map.Entry<String, Long>> it = sent.entrySet().iterator(); while (it.hasNext()) if (it.next().getValue() < lim) it.remove(); }
    return true;
  }

  void run() {
    while (running) {
      String status;
      try { status = tick(); prefs(this).edit().putLong("last", System.currentTimeMillis()).putString("err", "").apply(); }
      catch (Unknown e) {
        prefs(this).edit().putBoolean("on", false).putString("err", "Téléphone déconnecté de Ludy : réactivez les alertes dans Pauses").apply();
        alert("stop", "Ludy : alertes arrêtées", "Ce téléphone n'est plus autorisé (compte déconnecté ou retiré). Ouvrez Ludy > Pauses pour réactiver les alertes.", null);
        running = false; stopSelf(); return;
      } catch (Exception e) {
        status = "Réseau indisponible, nouvel essai dans 30 s";
        prefs(this).edit().putString("err", String.valueOf(e.getMessage())).apply();
      }
      if (!running) return;
      foreground(status);
      try { Thread.sleep(POLL_MS); } catch (InterruptedException e) { return; }
    }
  }

  static class Unknown extends Exception { }

  String http(String method, String url, String body, String secret) throws Exception {
    SharedPreferences p = prefs(this);
    String anon = p.getString("anon", "");
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setConnectTimeout(15000); c.setReadTimeout(25000); c.setRequestMethod(method);
    c.setRequestProperty("apikey", anon);
    c.setRequestProperty("Authorization", "Bearer " + anon);
    c.setRequestProperty("Content-Type", "application/json");
    if (secret != null) c.setRequestProperty("x-ludy-watch", secret);
    if (body != null) { c.setDoOutput(true); try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes("UTF-8")); } }
    int code = c.getResponseCode();
    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    if (in != null) { byte[] b = new byte[8192]; int n; while ((n = in.read(b)) > 0) buf.write(b, 0, n); in.close(); }
    String txt = buf.toString("UTF-8");
    if (txt.contains("watch_unknown")) throw new Unknown();
    if (code >= 400) throw new Exception("HTTP " + code);
    return txt;
  }

  /** Date ISO de la base (« 2026-11-14T17:35:12.1+00:00 », fraction de 0 à 6 chiffres) -> ms */
  static long t(String iso) {
    if (iso == null || iso.isEmpty() || iso.equals("null")) return 0;
    try {
      java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d{4}-\\d{2}-\\d{2})[T ](\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d+))?(Z|[+-]\\d{2}(?::?\\d{2})?)?$").matcher(iso.trim());
      if (!m.matches()) return 0;
      String frac = ((m.group(3) == null ? "" : m.group(3)) + "000").substring(0, 3), z = m.group(4) == null || m.group(4).equals("Z") ? "+00:00" : m.group(4);
      if (z.length() == 3) z += ":00"; else if (z.length() == 5) z = z.substring(0, 3) + ":" + z.substring(3);
      SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
      return f.parse(m.group(1) + "T" + m.group(2) + "." + frac + z).getTime();
    } catch (Exception e) { return 0; }
  }

  static String dur(long ms) {
    long m = Math.max(0, Math.round(ms / 60000.0));
    return m >= 60 ? (m / 60) + " h " + String.format(Locale.FRANCE, "%02d", m % 60) : m + " min";
  }

  /** Un passage : pauses et courses ouvertes, notifications ; renvoie le texte de la notification permanente */
  String tick() throws Exception {
    SharedPreferences p = prefs(this);
    String base = p.getString("url", ""), secret = p.getString("secret", "");
    JSONObject w = new JSONObject(http("POST", base + "/rest/v1/rpc/watch_poll", new JSONObject().put("p_secret", secret).toString(), null));
    JSONArray ps = w.optJSONArray("pauses"), ts = w.optJSONArray("tracks");
    int np = ps == null ? 0 : ps.length(), nt = ts == null ? 0 : ts.length();
    long now = System.currentTimeMillis();
    // positions Geotab (relais) : seulement quand une pause ou une course est suivie
    if ((np > 0 || nt > 0) && now - lastGeo >= GEO_MS) {
      lastGeo = now;
      try {
        JSONObject g = new JSONObject(http("GET", base + "/functions/v1/geotab-live?mode=watch", null, secret));
        if (g.has("pauses")) { ps = g.optJSONArray("pauses"); ts = g.optJSONArray("tracks"); np = ps == null ? 0 : ps.length(); nt = ts == null ? 0 : ts.length(); }
      } catch (Unknown e) { throw e; } catch (Exception e) { /* relais indisponible : base seule (déplacements vus par le collecteur ou le site) */ }
    }
    JSONObject P = w.optJSONObject("params");
    long remind = Math.max(5, P == null ? 30 : P.optLong("pauseRemindMin", 30)) * 60000;
    int over = 0, moved = 0;
    for (int i = 0; i < np; i++) {
      JSONObject x = ps.getJSONObject(i);
      String id = x.optString("id"), name = x.optString("driver_name", ""), plate = x.optString("plate", x.optString("vehicle_key")), phone = x.optString("driver_phone", "");
      if (name.equals("null")) name = ""; if (phone.equals("null")) phone = "";
      long start = t(x.optString("started_at")), planned = x.optLong("planned_min", 0) * 60000, end = start + planned;
      String who = (name.isEmpty() ? "Chauffeur" : name) + " · " + plate + (phone.isEmpty() ? "" : " · " + phone);
      // véhicule en pause qui bouge : alerte, répétée toutes les 2 min tant qu'il n'est pas revenu (relais), sauf déplacement autorisé
      String mvAt = x.optString("moved_at", "");
      if (!mvAt.isEmpty() && !mvAt.equals("null") && !allowed.contains(id)) {
        moved++;
        if (x.has("away")) away.put(id, x.optBoolean("away", true));
        boolean far = !away.containsKey(id) || away.get(id);   // jamais relevé par le relais : alerte répétée (sécurité)
        String note = x.optString("now_note", ""); if (note.isEmpty() || note.equals("null")) note = x.optString("moved_note", "en mouvement");
        String k = "m|" + id + (far ? "@" + (now / MOVE_EVERY) : "");
        if ((far || !sent.containsKey("m|" + id)) && once(k)) { sent.put("m|" + id, now);
          alert(k, "🔴 VÉHICULE EN PAUSE EN MOUVEMENT", who + "\nLe véhicule est " + note + " alors que le chauffeur est en pause depuis " + dur(now - start) + ".", id); }
      }
      if (now >= end) {
        over++;
        long late = now - end;
        String k = "e|" + id + "@" + (late / END_EVERY);
        if (once(k)) alert(k, "🔴 FIN DE PAUSE", who + "\nPause de " + (planned / 60000) + " min terminée" + (late >= 60000 ? ", dépassée de " + dur(late) : "") + " : le chauffeur doit reprendre.", null);
      } else {
        // rappel toutes les 30 min (le dernier seulement, jamais une rafale au démarrage)
        long el = now - start, n = el / remind;
        if (n >= 1 && n * remind < planned && el - n * remind < 5 * 60000) {
          String k = "r|" + id + "@" + n;
          if (once(k)) alert(k, "⏸ Pause en cours : " + dur(el), who + "\nReste " + dur(end - now) + ".", null);
        }
      }
    }
    for (int i = 0; i < nt; i++) {
      JSONObject x = ts.getJSONObject(i);
      String arr = x.optString("arrived_at", "");
      if (arr.isEmpty() || arr.equals("null")) continue;
      String k = "a|" + x.optString("id");
      if (now - t(arr) < 3 * 3600000L && once(k)) {
        String dest = x.optString("dest_label", ""); if (dest.equals("null")) dest = "";
        String name = x.optString("driver_name", ""); if (name.equals("null")) name = "";
        alert(k, "🟢 COURSE ARRIVÉE À DESTINATION", x.optString("plate") + (name.isEmpty() ? "" : " · " + name) + (dest.isEmpty() ? "" : "\n" + dest) + "\nArrivée il y a " + dur(now - t(arr)) + ". Levez le suivi dans Ludy.", null);
      }
    }
    String s = np == 0 && nt == 0 ? "Aucune pause en cours" : np + " pause(s) en cours" + (over > 0 ? " · " + over + " terminée(s)" : "") + (moved > 0 ? " · " + moved + " véhicule(s) en mouvement" : "") + (nt > 0 ? " · " + nt + " course(s) suivie(s)" : "");
    return s;
  }
}
