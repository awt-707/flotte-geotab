package com.ludy.flotte;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Application Ludy pour Android (1.1, 04/11/2026) : le site Ludy dans une vue web de l'application, sans dépendre de Chrome
 * (la 1.0, Trusted Web Activity, se fermait sur écran blanc chez Ahmed). Le site garde ses mises à jour sans réinstaller.
 * - liens hors du site (WhatsApp, e-mail, téléphone, autres sites) : ouverts dans l'application du téléphone ;
 * - fichiers à joindre (justificatifs, reçus, fiches) : galerie, fichiers ou appareil photo ;
 * - PDF et tableurs créés par le site (adresses blob:) : enregistrés dans Téléchargements puis ouverts.
 * 1.2 (04/11/2026, demande d'Ahmed) : PDF (manifeste, devis) partagés tels quels dans WhatsApp, directement au numéro du chauffeur ou
 *   du client (LudyAndroid.share ; fichier servi par FilesProvider, sans bibliothèque) ; sans WhatsApp : choix de l'application.
 */
public class MainActivity extends Activity {
  static final String HOME = "https://ludy-flotte.pages.dev/";
  static final String HOST = "ludy-flotte.pages.dev";
  static final int PICK = 1;
  WebView web;
  ValueCallback<Uri[]> pending;
  Uri photo;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    Window w = getWindow();
    w.setStatusBarColor(Color.parseColor("#0f2633"));
    w.setNavigationBarColor(Color.parseColor("#0f2633"));
    web = new WebView(this);
    web.setFitsSystemWindows(true);   // jamais sous la barre d'état ni la barre de navigation
    web.setBackgroundColor(Color.parseColor("#edf0f2"));
    setContentView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    s.setSupportMultipleWindows(false);   // target="_blank" : même vue, puis shouldOverrideUrlLoading
    s.setAllowFileAccess(false);
    s.setMediaPlaybackRequiresUserGesture(true);
    s.setUserAgentString(s.getUserAgentString() + " LudyAndroid/1.2");
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
    web.addJavascriptInterface(new Bridge(), "LudyAndroid");
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return route(r.getUrl()); }
      @SuppressWarnings("deprecation")
      @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return route(Uri.parse(url)); }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) { return choose(cb, p); }
    });
    web.setDownloadListener((url, ua, cd, mime, len) -> download(url, cd, mime));
    if (b != null) web.restoreState(b); else web.loadUrl(HOME);
  }

  /** true = lien ouvert hors de la vue (WhatsApp, e-mail, téléphone, autre site) */
  boolean route(Uri u) {
    String sc = u.getScheme() == null ? "" : u.getScheme();
    if ((sc.equals("https") || sc.equals("http")) && HOST.equals(u.getHost())) return false;
    if (sc.equals("blob") || sc.equals("data") || sc.equals("about") || sc.equals("javascript")) return false;
    // liens signés de Supabase (PDF, justificatifs) : ouverts par le téléphone (lecteur PDF, galerie)
    try { Intent i = new Intent(Intent.ACTION_VIEW, u); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); }
    catch (ActivityNotFoundException e) { Toast.makeText(this, "Aucune application pour ouvrir ce lien", Toast.LENGTH_LONG).show(); }
    return true;
  }

  boolean choose(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams p) {
    if (pending != null) pending.onReceiveValue(null);
    pending = cb; photo = null;
    Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
    pick.addCategory(Intent.CATEGORY_OPENABLE);
    String[] types = p.getAcceptTypes();
    StringBuilder acc = new StringBuilder();
    for (String t : types) if (t != null && !t.isEmpty()) acc.append(acc.length() > 0 ? "," : "").append(t);
    String a = acc.toString();
    if (a.isEmpty() || a.contains(",")) { pick.setType("*/*"); if (!a.isEmpty()) pick.putExtra(Intent.EXTRA_MIME_TYPES, a.replace(" ", "").split(",")); }
    else pick.setType(a.startsWith(".") ? "*/*" : a);
    Intent chooser = Intent.createChooser(pick, "Choisir un fichier");
    // appareil photo (photo enregistrée dans la galerie, puis jointe)
    if ((a.isEmpty() || a.contains("image")) && Build.VERSION.SDK_INT >= 29) {
      try {
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.Images.Media.DISPLAY_NAME, "ludy_" + System.currentTimeMillis() + ".jpg");
        cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        cv.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Ludy");
        photo = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
        Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        cam.putExtra(MediaStore.EXTRA_OUTPUT, photo);
        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { cam });
      } catch (Exception e) { photo = null; }
    }
    try { startActivityForResult(chooser, PICK); }
    catch (ActivityNotFoundException e) { pending = null; Toast.makeText(this, "Aucune application pour choisir un fichier", Toast.LENGTH_LONG).show(); return false; }
    return true;
  }

  @Override protected void onActivityResult(int req, int res, Intent data) {
    if (req != PICK || pending == null) { super.onActivityResult(req, res, data); return; }
    Uri[] out = null;
    if (res == RESULT_OK) {
      if (data != null && data.getClipData() != null) {
        out = new Uri[data.getClipData().getItemCount()];
        for (int i = 0; i < out.length; i++) out[i] = data.getClipData().getItemAt(i).getUri();
      } else if (data != null && data.getData() != null) out = new Uri[] { data.getData() };
      else if (photo != null) out = new Uri[] { photo };
    }
    if (out == null && photo != null) { try { getContentResolver().delete(photo, null, null); } catch (Exception e) { } }
    pending.onReceiveValue(out); pending = null; photo = null;
  }

  /** Téléchargement : adresse blob: (PDF, tableurs créés par le site) lue par la page puis enregistrée ; sinon ouverte par le téléphone */
  void download(String url, String cd, String mime) {
    String name = URLUtil.guessFileName(url, cd, mime);
    if (url.startsWith("blob:")) {
      String js = "(function(){var u=" + q(url) + ";var x=new XMLHttpRequest();x.open('GET',u,true);x.responseType='blob';x.onload=function(){var r=new FileReader();"
        + "r.onloadend=function(){LudyAndroid.save(String(r.result).split(',')[1]||'',(window.__ludyDlName||" + q(name) + "),x.response.type||" + q(mime == null ? "" : mime) + ");};r.readAsDataURL(x.response);};x.send();})();";
      web.evaluateJavascript(js, null);
      return;
    }
    route(Uri.parse(url));
  }
  static String q(String s) { return "'" + String.valueOf(s).replace("\\", "\\\\").replace("'", "\\'") + "'"; }

  class Bridge {
    /** PDF créé par le site (base64) envoyé dans WhatsApp au numéro donné (vide : choisir la conversation) */
    @JavascriptInterface public void share(String b64, String name, String mime, String text, String phone) {
      runOnUiThread(() -> {
        try {
          String n = name == null || name.isEmpty() ? "document.pdf" : name.replaceAll("[\\\\/:*?\"<>|]+", "_");
          shareFile(Base64.decode(b64, Base64.DEFAULT), n, mime == null || mime.isEmpty() ? "application/pdf" : mime, text, phone);
        } catch (Exception e) { Toast.makeText(MainActivity.this, "Partage impossible : " + e.getMessage(), Toast.LENGTH_LONG).show(); }
      });
    }
    @JavascriptInterface public void save(String b64, String name, String mime) {
      runOnUiThread(() -> {
        try {
          byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
          String n = name == null || name.isEmpty() ? "document" : name.replaceAll("[\\\\/:*?\"<>|]+", "_");
          String m = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
          Uri uri;
          if (Build.VERSION.SDK_INT >= 29) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, n);
            cv.put(MediaStore.Downloads.MIME_TYPE, m);
            uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            try (OutputStream o = getContentResolver().openOutputStream(uri)) { o.write(bytes); }
          } else {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), f = new File(dir, n);
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(bytes); }
            Toast.makeText(MainActivity.this, n + " enregistré", Toast.LENGTH_LONG).show();
            return;
          }
          Toast.makeText(MainActivity.this, n + " enregistré dans Téléchargements", Toast.LENGTH_SHORT).show();
          Intent i = new Intent(Intent.ACTION_VIEW); i.setDataAndType(uri, m);
          i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
          try { startActivity(i); } catch (ActivityNotFoundException e) { }
        } catch (Exception e) { Toast.makeText(MainActivity.this, "Enregistrement impossible : " + e.getMessage(), Toast.LENGTH_LONG).show(); }
      });
    }
  }

  /** Fichier partagé : copié dans le cache de l'application (dossier share, servi par FilesProvider), puis envoyé à WhatsApp */
  void shareFile(byte[] bytes, String name, String mime, String text, String phone) throws Exception {
    File dir = new File(getCacheDir(), "share");
    dir.mkdirs();
    File[] old = dir.listFiles();
    if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 86400000L) f.delete();   // fichiers de plus d'un jour retirés
    File f = new File(dir, name);
    try (FileOutputStream o = new FileOutputStream(f)) { o.write(bytes); }
    Uri uri = Uri.parse("content://" + FilesProvider.AUTH + "/" + Uri.encode(name));
    Intent i = new Intent(Intent.ACTION_SEND);
    i.setType(mime);
    i.putExtra(Intent.EXTRA_STREAM, uri);
    if (text != null && !text.isEmpty()) i.putExtra(Intent.EXTRA_TEXT, text);
    i.setClipData(ClipData.newRawUri(name, uri));
    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    String digits = phone == null ? "" : phone.replaceAll("[^0-9]", "");
    // WhatsApp (puis WhatsApp Business) : conversation du numéro ouverte avec le PDF joint ; sinon choix de l'application
    for (String pkg : new String[] { "com.whatsapp", "com.whatsapp.w4b" }) {
      Intent w = new Intent(i).setPackage(pkg);
      if (digits.length() >= 8) w.putExtra("jid", digits + "@s.whatsapp.net");
      try { startActivity(w); return; } catch (ActivityNotFoundException e) { }
    }
    startActivity(Intent.createChooser(i, "Partager " + name));
  }

  @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
  @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); if (web != null) web.saveState(o); }
  @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }
}
