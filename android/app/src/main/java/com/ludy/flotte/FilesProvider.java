package com.ludy.flotte;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Fichiers partagés par l'application (PDF du manifeste, du devis…) : lecture seule, dossier « share » du cache seulement,
 * accessible uniquement à l'application qui a reçu le partage (android:exported="false", droits accordés par l'intention).
 * Remplace FileProvider d'androidx (l'application n'embarque aucune bibliothèque).
 */
public class FilesProvider extends ContentProvider {
  static final String AUTH = "com.ludy.flotte.files";

  File fileOf(Uri uri) throws FileNotFoundException {
    String name = uri.getLastPathSegment();
    if (name == null || name.contains("/") || name.contains("..")) throw new FileNotFoundException("fichier refusé");
    File dir = new File(getContext().getCacheDir(), "share"), f = new File(dir, name);
    if (!f.isFile()) throw new FileNotFoundException(name);
    return f;
  }
  @Override public boolean onCreate() { return true; }
  @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new FileNotFoundException("lecture seule");
    return ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }
  @Override public String getType(Uri uri) {
    String n = String.valueOf(uri.getLastPathSegment()).toLowerCase();
    return n.endsWith(".pdf") ? "application/pdf" : n.endsWith(".png") ? "image/png" : n.endsWith(".jpg") || n.endsWith(".jpeg") ? "image/jpeg" : "application/octet-stream";
  }
  @Override public Cursor query(Uri uri, String[] proj, String sel, String[] args, String sort) {
    try {
      File f = fileOf(uri);
      MatrixCursor c = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
      c.addRow(new Object[] { f.getName(), f.length() });
      return c;
    } catch (FileNotFoundException e) { return null; }
  }
  @Override public Uri insert(Uri uri, ContentValues v) { return null; }
  @Override public int delete(Uri uri, String s, String[] a) { return 0; }
  @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}
