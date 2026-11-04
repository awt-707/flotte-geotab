// Both public Bolt specifications were checked on 2026-11-03. They expose
// company/identity/driver/vehicle reads and getRideHistory, not a financial
// statement or settlement API. This is a capability result, never an empty
// successful financial report. Revisit it only against a documented contract.
const PORTAL = 'https://developer.bolt.eu/fleet-integration/main/';
const SPEC = 'https://developer.bolt.eu/versions/114.0.0/docs/fleet-integration/main.yaml';
const TECHNICAL_SPEC = 'https://apidocs.bolt.eu/fleetIntegration/fleetIntegrationGatewayV2Auth/open-api.json';
const ORDER_SCHEMA = 'https://developer.bolt.eu/versions/114.0.0/docs/fleet-integration/spec/components/Order.yaml';

export function boltFinancialCapabilities() {
  return {
    source: 'bolt',
    status: 'unsupported',
    reasonCode: 'NO_DOCUMENTED_FINANCIAL_ENDPOINT',
    message: 'L’API Bolt documentée fournit les prix des courses, sans relevé de revenus, commissions, encaissements ou versements. Les relevés financiers importés restent nécessaires.',
    endpoint: null,
    authorization: 'not_checked',
    canReplaceLegacyStatements: false,
    canPopulateCashShifts: false,
    coverage: {complete: false, kind: 'unavailable'},
    metrics: {
      revenue: false,
      gross: false,
      net: false,
      commission: false,
      bonus: false,
      payout: false,
      cashCollected: false,
      endBalance: false
    },
    operationalData: {
      endpoint: 'getRideHistory',
      kind: 'ride_price',
      fields: ['price.currency', 'price.total', 'price.tip', 'price.booking_fee', 'price.toll_fee', 'price.cancellation_fee', 'payment_method'],
      usableAsStatement: false,
      notes: [
        'Le prix total et ses composantes ne certifient ni revenu brut, ni net après commissions, ni versement.',
        'Le mode cash indique le mode de paiement, pas le montant effectivement encaissé.',
        'Le champ value_net des critères d’acceptation automatique est un seuil de prix par kilomètre, pas un gain.',
        'Les prix des courses ne doivent pas être ajoutés aux relevés bolt_sessions couvrant les mêmes opérations.'
      ]
    },
    documentation: {checkedOn: '2026-11-03', portalVersion: '114.0.0', portal: PORTAL, specification: SPEC, technicalSpecification: TECHNICAL_SPEC, orderSchema: ORDER_SCHEMA}
  };
}
