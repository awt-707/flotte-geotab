// Noms des règles Geotab en français partout (affichage ; la base garde le nom Geotab)
const test = require('node:test'), assert = require('node:assert');
const { rptRuleFr } = require('../site/report.js');
test('règles Geotab traduites, « (New) » retiré, nom inconnu gardé', () => {
  assert.deepStrictEqual(['Speeding (New)', 'Harsh Braking (New)', 'Harsh Acceleration (New)', 'Harsh Cornering (New)', 'Seat belt', 'Engine Fault Exception', 'Possible Collision (New)', 'Ma règle'].map(rptRuleFr),
    ['Excès de vitesse', 'Freinage brusque', 'Accélération brusque', 'Virage brusque', 'Ceinture non bouclée', 'Défaut moteur', 'Collision possible', 'Ma règle']);
});
