# Dépendance SheetJS

`xlsx-0.20.3.tgz` est l'archive officielle SheetJS Community Edition téléchargée le 3 novembre 2026 depuis :

<https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz>

La [documentation officielle d'installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) identifie ce CDN comme source des versions récentes et recommande de conserver une copie de l'archive. Le paquet `xlsx` du registre npm reste à la version 0.18.5.

- Version : **0.20.3**.
- Licence : Apache-2.0, incluse dans l'archive.
- SHA-256 : `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`.
- Installation : dépendance `file:vendor/xlsx-0.20.3.tgz`, intégrité SHA-512 verrouillée dans `package-lock.json`.

Le bundle serveur inclut cette archive précise et sa provenance ; `npm ci` n'a donc pas besoin de contacter le CDN SheetJS. Les dépendances installées restent exclues du bundle. Aucun script d'installation de l'archive n'a été exécuté pendant la mise à jour.

Les imports continuent à passer par un Worker jetable sans réseau, avec les limites de taille, décompression, lignes, cellules et temps de traitement déjà en place. Les tests CSV/XLS/XLSX utilisent les fichiers de la dépendance **du staging**, et non ceux de l'application de production.
