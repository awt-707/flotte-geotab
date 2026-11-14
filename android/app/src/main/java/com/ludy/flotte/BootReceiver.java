package com.ludy.flotte;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Téléphone redémarré ou application mise à jour : surveillance des pauses relancée si elle était active (Ludy 1.3) */
public class BootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context c, Intent i) {
    String a = i == null ? "" : String.valueOf(i.getAction());
    if (!a.equals(Intent.ACTION_BOOT_COMPLETED) && !a.equals(Intent.ACTION_MY_PACKAGE_REPLACED)) return;
    if (!WatchService.enabled(c)) return;
    try { WatchService.start(c); } catch (Exception e) { /* démarrage refusé par le système : relancé à la prochaine ouverture de Ludy */ }
  }
}
