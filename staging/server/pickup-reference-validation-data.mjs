// Aggregate evidence for the explicitly reviewed local files. No trip identifiers or addresses.
export default {
  "version": 1,
  "checkedAt": "2026-11-03",
  "source": {
    "filename": "20261003-20261103-trip_activity-LUXURY_DISCOVERY.csv",
    "sha256": "8429cace5a94c237a0e68511a0468f7b458dd5ddf003403c280128eaeb2ae7e8",
    "rows": 6544,
    "uniqueTripIds": 6544,
    "duplicateRows": 0,
    "localTimeZone": "Africa/Casablanca",
    "timezoneEvidence": "Confirmation utilisateur pour cet export"
  },
  "referenceSha256": "27479317e095b9a253c14d8af49b20549f6e5e332486e813e5e968e235807c54",
  "agencyIds": {
    "Casablanca": 1,
    "Marrakech": 2
  },
  "cities": {
    "Casablanca": {
      "sourceRows": 5220,
      "eligibleRows": 5219,
      "completed": 4125,
      "cancelled": 1094,
      "excludedStatuses": 1,
      "observedLocalTime": {
        "from": "2026-10-02 23:31:16",
        "to": "2026-11-02 23:44:16"
      },
      "declaredPeriod": {
        "from": "2026-10-03",
        "to": "2026-11-02"
      },
      "eligibleInDeclaredPeriod": 5214,
      "outsideDeclaredPeriod": 5,
      "declaredRequests": 5945,
      "declaredCountReproduced": false,
      "differenceAgainstFullImport": 726,
      "differenceWithinDeclaredPeriod": 731,
      "unimportedAliasCandidates": 555,
      "confirmedLocalitySuffixRows": 537,
      "eligibleAfterLocalityReview": 5756,
      "confirmedSuffixStatuses": {
        "completed": 421,
        "rider_cancelled": 111,
        "driver_cancelled": 5
      },
      "simpleCityLabel": {
        "numerator": 281,
        "denominator": 5219,
        "percent": 5.38,
        "definition": "Libellé intégral : ville seule, code postal facultatif et suffixe Maroc/Morocco facultatif ; statuts terminés ou annulés.",
        "sameDefinitionAsDeclared": false
      },
      "simpleCityLabelInDeclaredPeriod": {
        "numerator": 281,
        "denominator": 5214,
        "percent": 5.39
      },
      "plusCodes": {
        "rows": 271,
        "recoveredRows": 260,
        "uniqueRecovered": 106,
        "unresolvedRows": 11,
        "coverage": {
          "numerator": 270,
          "denominator": 5219,
          "percent": 5.17
        }
      },
      "scope": "Ce fichier source seulement ; aucune affectation de ville/agence et aucune coordonnée de course modifiée."
    },
    "Marrakech": {
      "sourceRows": 501,
      "eligibleRows": 501,
      "completed": 446,
      "cancelled": 55,
      "excludedStatuses": 0,
      "observedLocalTime": {
        "from": "2026-10-05 08:05:14",
        "to": "2026-11-02 23:45:55"
      },
      "declaredPeriod": {
        "from": "2026-10-28",
        "to": "2026-11-02"
      },
      "eligibleInDeclaredPeriod": 495,
      "outsideDeclaredPeriod": 6,
      "declaredRequests": null,
      "declaredCountReproduced": false,
      "differenceAgainstFullImport": null,
      "differenceWithinDeclaredPeriod": null,
      "unimportedAliasCandidates": 20,
      "confirmedLocalitySuffixRows": 20,
      "eligibleAfterLocalityReview": 521,
      "confirmedSuffixStatuses": {
        "completed": 19,
        "rider_cancelled": 1,
        "driver_cancelled": 0
      },
      "simpleCityLabel": {
        "numerator": 55,
        "denominator": 501,
        "percent": 10.98,
        "definition": "Libellé intégral : ville seule, code postal facultatif et suffixe Maroc/Morocco facultatif ; statuts terminés ou annulés.",
        "sameDefinitionAsDeclared": false
      },
      "simpleCityLabelInDeclaredPeriod": {
        "numerator": 54,
        "denominator": 495,
        "percent": 10.91
      },
      "plusCodes": {
        "rows": 14,
        "recoveredRows": 14,
        "uniqueRecovered": 14,
        "unresolvedRows": 0,
        "coverage": {
          "numerator": 14,
          "denominator": 501,
          "percent": 2.79
        }
      },
      "scope": "Ce fichier source seulement ; aucune affectation de ville/agence et aucune coordonnée de course modifiée."
    }
  },
  "codeChecks": [
    {
      "entryId": "6b0b260cfd0555000f505098",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "5916c414001aa8927f918e5f",
      "status": "coordinate_consistent_with_contextual_code",
      "thresholdMeters": 10,
      "nearestMeters": 4,
      "matchingCodes": 1,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "5ac4539fb0ff2fe26f33d10e",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 268,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "f22aae0687922fbeacd108d4",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "a8ea5b083a689da8c0d45141",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 564,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "315314b5524bfc2f57e9f21c",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 303,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "5abc179f431c178cbd2f12bc",
      "status": "coordinate_consistent_with_contextual_code",
      "thresholdMeters": 10,
      "nearestMeters": 5,
      "matchingCodes": 1,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "4ad31ec7636d600f4d514155",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "d6d2222a29a0a1c530efbd1d",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 224,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "f2c595234b820f6f37c5a63e",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 686,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "09bdd749c01fb893aa91d935",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 817,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "507a44af91cd0b1c7e2799f9",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "5427c7c8c6142ab875ec2d88",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 107,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "1c68cd0f49b8abb24c537e81",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 509,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "006dffe1458898d714a78991",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 528,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "10d005d8ff0fcb9fc94a7e0c",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 742,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "d4692eb8cc06697f80433025",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "153e96d8c3e1cb524228db62",
      "status": "coordinate_consistent_with_contextual_code",
      "thresholdMeters": 10,
      "nearestMeters": 3,
      "matchingCodes": 1,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "fd23d63630b95bd51fc1de95",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 13,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "a012bd806e8f13fa6d4fec7c",
      "status": "coordinate_consistent_with_contextual_code",
      "thresholdMeters": 10,
      "nearestMeters": 2,
      "matchingCodes": 1,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "bd75ac56318eed2e3e1696f5",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "ca6bf34d76ddd78d275dc4d4",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 283,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "a2dc578343680a836a047b2e",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 587,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "e2177b76ac04829ba5905602",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 3632,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "0ee670617a4af25d3b8fc497",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "2b98ef481c9a56ddf132766c",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 249,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "bae1239bb3ba95d2f080958d",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 447,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "a1efe64e64af4f974ea861b2",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 470,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "6e5d54c37ce7ec6d739423c0",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "c818dbea881d18b18191bf0a",
      "status": "coordinate_consistent_with_contextual_code",
      "thresholdMeters": 10,
      "nearestMeters": 6,
      "matchingCodes": 1,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "455a0e924f447ab58e58d149",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 618,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "72151b64f0801eae50d263d4",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "6110d53587d4aea02ac157b3",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 3839,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "b6b478432be56f91d24a99d8",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 17545,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "15490b62687401e6b267d003",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 6724,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "08e184a78e3d5c521242bcee",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "cb73c198c5a13b44ec17596f",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 1102,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "17aa493609cd3226e418df03",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 794,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "81a63d83cfecb36c513d678a",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "2b1764252ed69cef91bf1d61",
      "status": "coordinate_consistent_with_contextual_code",
      "thresholdMeters": 10,
      "nearestMeters": 2,
      "matchingCodes": 1,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "92b387d187103413ca4af718",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 201,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "8e9c6f1af58e991979649c1c",
      "status": "coordinate_consistent_with_contextual_code",
      "thresholdMeters": 10,
      "nearestMeters": 4,
      "matchingCodes": 1,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "72f4e03e406b534286981d95",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 1051,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "a6f235da0fb924e2be8383fb",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 2266,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "109ccd6748b95887e84a3677",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "89d12ffd3208bcd734564e0f",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 88,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "c16c28a135e23153621db95d",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 550,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "a0206758444fb5eb1e7586eb",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "c50602c541fe477ce42bcc29",
      "status": "coordinate_consistent_with_contextual_code",
      "thresholdMeters": 10,
      "nearestMeters": 4,
      "matchingCodes": 1,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "b23afa4e30ef07dfe44b78ed",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 796,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "44539f1f2624beb017dc9234",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "456c5b1011cc8579eb56d955",
      "status": "indicative_center_not_a_raw_code"
    },
    {
      "entryId": "088890e956e9769688575b74",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 4850,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    },
    {
      "entryId": "7778e8f508e239c6dd5282ee",
      "status": "not_reproduced_in_this_export",
      "thresholdMeters": 10,
      "nearestMeters": 714,
      "matchingCodes": 0,
      "venueIdentityVerified": false,
      "pickupVerified": false,
      "note": "Comparaison de coordonnées seulement, avec seuil explicite de 10 m. Le nom du lieu et une prise en charge effective ne sont pas certifiés."
    }
  ]
};
