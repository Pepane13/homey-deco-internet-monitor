'use strict';

// Generates com.pepane13.netmonitor/app.json (single source of truth for the manifest).
// Usage: node tools/build-manifest.js
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'com.pepane13.netmonitor');
const pkg = require(path.join(APP, 'package.json'));
const t = (en, fr) => ({ en, fr });

// ------------------------------------------------------------------ capabilities
const num = (title, units, decimals, icon, extra = {}) => ({
  type: 'number', title, units: units ? t(units, units) : undefined, decimals,
  getable: true, setable: false, uiComponent: 'sensor', insights: true, chartType: 'spline',
  icon: `/assets/capabilities/${icon}.svg`, ...extra,
});
const bool = (title, trueTxt, falseTxt, icon) => ({
  type: 'boolean', title, getable: true, setable: false, uiComponent: 'sensor', insights: true,
  insightsTitleTrue: trueTxt, insightsTitleFalse: falseTxt, icon: `/assets/capabilities/${icon}.svg`,
});
const str = (title, icon) => ({
  type: 'string', title, getable: true, setable: false, uiComponent: 'sensor', icon: `/assets/capabilities/${icon}.svg`,
});

const capabilities = {
  netmon_online: bool(t('Connected', 'Connecté'), t('Connected', 'Connecté'), t('Disconnected', 'Déconnecté'), 'online'),
  netmon_status: {
    type: 'enum', title: t('Status', 'État'), getable: true, setable: false, uiComponent: 'sensor',
    icon: '/assets/capabilities/status.svg',
    values: [
      { id: 'ok', title: t('Good', 'Bon') },
      { id: 'degraded', title: t('Degraded', 'Dégradé') },
      { id: 'down', title: t('Down', 'Coupé') },
      { id: 'unknown', title: t('Unknown', 'Inconnu') },
    ],
  },
  netmon_download: num(t('Download', 'Débit descendant'), 'Mbit/s', 1, 'download'),
  netmon_upload: num(t('Upload', 'Débit montant'), 'Mbit/s', 1, 'upload'),
  netmon_latency: num(t('Latency', 'Latence'), 'ms', 1, 'latency'),
  netmon_jitter: num(t('Jitter', 'Gigue'), 'ms', 1, 'latency'),
  netmon_loss: num(t('Packet loss', 'Perte de paquets'), '%', 0, 'loss'),
  netmon_dns: num(t('DNS resolution', 'Résolution DNS'), 'ms', 0, 'latency'),
  netmon_outages: num(t('Outages today', 'Coupures du jour'), null, 0, 'status', { chartType: 'stepLine' }),
  netmon_downtime: num(t('Downtime today', 'Durée de coupure du jour'), 'min', 1, 'status', { chartType: 'stepLine' }),
  netmon_throughput: num(t('Traffic', 'Trafic'), 'Mbit/s', 1, 'download'),
  netmon_power: num(t('Optical power', 'Puissance optique'), 'dBm', 2, 'fiber'),
  netmon_uptime: num(t('Uptime', 'Durée de connexion'), 'h', 1, 'status', { chartType: 'stepLine' }),
  netmon_ip: str(t('Public IP', 'IP publique'), 'online'),
  netmon_text: str(t('Info', 'Info'), 'status'),
  netmon_rate: str(t('Average traffic', 'Débit moyen'), 'download'),
  netmon_clients: num(t('Clients', 'Clients'), null, 0, 'clients', { chartType: 'stepLine' }),
  netmon_signal: num(t('Backhaul signal', 'Signal de liaison'), null, 0, 'wifi', { chartType: 'stepLine' }),
  netmon_speed: num(t('Backhaul speed', 'Débit de liaison'), 'Mbit/s', 0, 'wifi'),
  netmon_load: num(t('Load', 'Charge'), '%', 0, 'cpu'),
  netmon_quality: num(t('Link quality', 'Qualité de la liaison'), '%', 0, 'fiber', { min: 0, max: 100 }),
};
for (const c of Object.values(capabilities)) if (c.units === undefined) delete c.units;

// ------------------------------------------------------------------ drivers
const opt = (title) => ({ title });
const conn = (children) => ({ type: 'group', label: t('Connection', 'Connexion'), children });
const numberSetting = (id, label, value, min, max, units, hint) => ({
  id, type: 'number', label, value, min, max, ...(units ? { units: t(units, units) } : {}), ...(hint ? { hint } : {}),
});

const images = (id) => ({ small: `/drivers/${id}/assets/images/small.png`, large: `/drivers/${id}/assets/images/large.png`, xlarge: `/drivers/${id}/assets/images/xlarge.png` });

const drivers = [
  {
    id: 'internet',
    name: t('Internet quality', 'Qualité Internet'),
    class: 'sensor',
    capabilities: [
      'netmon_status', 'netmon_online', 'netmon_download', 'netmon_upload', 'netmon_latency', 'netmon_jitter',
      'netmon_loss', 'netmon_latency.gateway', 'netmon_dns', 'netmon_latency.speedtest', 'netmon_outages', 'netmon_downtime',
    ],
    capabilitiesOptions: {
      netmon_online: opt(t('Internet', 'Internet')),
      netmon_latency: opt(t('Latency (Internet)', 'Latence (Internet)')),
      'netmon_latency.gateway': opt(t('Latency (box)', 'Latence (box)')),
      'netmon_latency.speedtest': opt(t('Latency (speed test)', 'Latence (test de débit)')),
    },
    platforms: ['local'],
    connectivity: ['lan'],
    images: images('internet'),
    pair: [{ id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } }, { id: 'add_devices', template: 'add_devices' }],
    settings: [
      {
        type: 'group', label: t('Connectivity probes', 'Sondes de connectivité'), children: [
          numberSetting('probe_interval', t('Probe interval', 'Intervalle des sondes'), 30, 10, 600, 's'),
          {
            id: 'probe_targets', type: 'text', label: t('Internet targets', 'Cibles Internet'),
            value: '1.1.1.1:443, 8.8.8.8:443, 9.9.9.9:443',
            hint: t('Host:port list, separated by commas. Latency is the TCP handshake time (Homey apps cannot send ICMP pings). Internet is considered down only when every target fails.',
              'Liste hôte:port séparée par des virgules. La latence est le temps de connexion TCP (une app Homey ne peut pas envoyer de ping ICMP). Internet est considéré coupé seulement si toutes les cibles échouent.'),
          },
          {
            id: 'gateway', type: 'text', label: t('Box address', 'Adresse de la box'), value: '192.168.1.1:80',
            hint: t('Measures the local network latency up to the box, to tell a LAN problem from an Internet one. Leave empty to disable.',
              'Mesure la latence du réseau local jusqu\'à la box, pour distinguer un problème local d\'un problème Internet. Laisser vide pour désactiver.'),
          },
          numberSetting('confirm_rounds', t('Outage confirmation', 'Confirmation de coupure'), 2, 1, 10, null,
            t('Number of consecutive failed probe rounds before an outage is declared.', 'Nombre de séries de sondes en échec consécutives avant de déclarer une coupure.')),
        ],
      },
      {
        type: 'group', label: t('Speed test', 'Test de débit'), children: [
          {
            id: 'speedtest_source', type: 'dropdown', label: t('Speed test source', 'Source du test de débit'), value: 'auto',
            hint: t('Livebox: test run by the box itself towards Orange servers, measures the full line speed. Homey: test run from Homey towards Cloudflare, limited by the Homey Ethernet port. Automatic: Livebox when a Livebox device is paired, Homey otherwise or if the Livebox test fails. (The Deco speed test is only available through the TP-Link cloud.)',
              'Livebox : test lancé par la box elle-même vers les serveurs Orange, mesure le vrai débit de la ligne. Homey : test lancé depuis la Homey vers Cloudflare, limité par le port Ethernet de la Homey. Automatique : la Livebox si un appareil Livebox est ajouté, sinon ou en cas d\'échec la Homey. (Le test de débit des Deco n\'est accessible que via le cloud TP-Link.)'),
            values: [
              { id: 'auto', label: t('Automatic', 'Automatique') },
              { id: 'livebox', label: t('Box only (Livebox)', 'Box uniquement (Livebox)') },
              { id: 'homey', label: t('Homey (Cloudflare)', 'Homey (Cloudflare)') },
            ],
          },
          numberSetting('speedtest_interval', t('Speed test interval', 'Intervalle du test de débit'), 180, 0, 1440, 'min',
            t('0 = automatic tests disabled (use the Flow action). Each test transfers data: at 100 Mbit/s for 8 s, about 200 MB per test.',
              '0 = tests automatiques désactivés (utiliser l\'action de Flow). Chaque test consomme des données : à 100 Mbit/s pendant 8 s, environ 200 Mo par test.')),
          numberSetting('speedtest_duration', t('Duration per direction (Homey source)', 'Durée par sens (source Homey)'), 8, 4, 20, 's'),
          numberSetting('speedtest_streams', t('Parallel connections (Homey source)', 'Connexions parallèles (source Homey)'), 4, 1, 8),
          {
            id: 'speedtest_note', type: 'label', label: t('Measurement limit', 'Limite de mesure'), value: '100 Mbit/s',
            hint: t('Homey source only: Homey Pro (Early 2023) has a 100 Mbit/s Ethernet adapter, so results cannot exceed ~94 Mbit/s even on a gigabit fibre line. The Livebox source has no such limit. Set the thresholds according to the source.',
              'Source Homey uniquement : la Homey Pro (Early 2023) a un adaptateur Ethernet à 100 Mbit/s, les résultats ne peuvent donc pas dépasser ~94 Mbit/s, même sur une fibre gigabit. La source Livebox n\'a pas cette limite. Réglez les seuils selon la source.'),
          },
        ],
      },
      {
        type: 'group', label: t('Alert thresholds', 'Seuils d\'alerte'), children: [
          numberSetting('min_download', t('Minimum download (Livebox test)', 'Débit descendant minimum (test Livebox)'), 500, 0, 10000, 'Mbit/s',
            t('Line speed measured by the box. Sosh / Orange fibre 1 Gbit/s: usually 800-940 Mbit/s. 0 = no alert.', 'Débit de la ligne mesuré par la box. Fibre Sosh / Orange 1 Gbit/s : en général 800-940 Mbit/s. 0 = pas d\'alerte.')),
          numberSetting('min_upload', t('Minimum upload (Livebox test)', 'Débit montant minimum (test Livebox)'), 400, 0, 10000, 'Mbit/s',
            t('Sosh fibre: up to 800 Mbit/s upload, usually 600-750. 0 = no alert.', 'Fibre Sosh : jusqu\'à 800 Mbit/s en montant, en général 600-750. 0 = pas d\'alerte.')),
          numberSetting('min_download_homey', t('Minimum download (Homey test)', 'Débit descendant minimum (test Homey)'), 60, 0, 10000, 'Mbit/s',
            t('Used when the test runs from Homey (capped at ~94 Mbit/s by its Ethernet port). 0 = no alert.', 'Utilisé quand le test est lancé depuis la Homey (plafonné à ~94 Mbit/s par son port Ethernet). 0 = pas d\'alerte.')),
          numberSetting('min_upload_homey', t('Minimum upload (Homey test)', 'Débit montant minimum (test Homey)'), 60, 0, 10000, 'Mbit/s', t('0 = no alert.', '0 = pas d\'alerte.')),
          numberSetting('max_latency', t('Maximum latency', 'Latence maximum'), 30, 0, 2000, 'ms', t('0 = no alert.', '0 = pas d\'alerte.')),
          numberSetting('max_jitter', t('Maximum jitter', 'Gigue maximum'), 15, 0, 1000, 'ms', t('0 = no alert.', '0 = pas d\'alerte.')),
          numberSetting('max_loss', t('Maximum packet loss', 'Perte de paquets maximum'), 10, 0, 100, '%', t('0 = no alert.', '0 = pas d\'alerte.')),
          numberSetting('consecutive', t('Consecutive measurements', 'Mesures consécutives'), 2, 1, 10, null,
            t('A threshold must be crossed this many times in a row to raise (and to clear) an alert.', 'Un seuil doit être franchi autant de fois de suite pour lever (et pour lever la fin d\') une alerte.')),
        ],
      },
    ],
  },
  {
    id: 'livebox',
    name: t('Internet box', 'Box Internet'),
    class: 'sensor',
    capabilities: [
      'netmon_online', 'netmon_quality', 'netmon_power.rx', 'netmon_power.tx', 'netmon_throughput.down', 'netmon_throughput.up',
      'netmon_download.box', 'netmon_upload.box', 'netmon_latency.box',
      'netmon_uptime.wan', 'netmon_uptime.box', 'netmon_ip', 'netmon_text',
    ],
    capabilitiesOptions: {
      netmon_online: opt(t('Internet link', 'Lien Internet')),
      'netmon_power.rx': opt(t('Received optical power', 'Puissance optique reçue')),
      'netmon_power.tx': opt(t('Transmitted optical power', 'Puissance optique émise')),
      'netmon_throughput.down': opt(t('Download traffic', 'Trafic descendant')),
      'netmon_throughput.up': opt(t('Upload traffic', 'Trafic montant')),
      'netmon_uptime.wan': opt(t('Internet connection uptime', 'Durée de la connexion Internet')),
      'netmon_uptime.box': opt(t('Box uptime', 'Durée de fonctionnement de la box')),
      netmon_text: opt(t('Line state', 'État de la ligne')),
      netmon_quality: opt(t('Internet link quality', 'Qualité de la liaison Internet')),
      'netmon_download.box': opt(t('Download (box speed test)', 'Débit descendant (test de la box)')),
      'netmon_upload.box': opt(t('Upload (box speed test)', 'Débit montant (test de la box)')),
      'netmon_latency.box': opt(t('Latency (box speed test)', 'Latence (test de la box)')),
    },
    platforms: ['local'],
    connectivity: ['lan'],
    images: images('livebox'),
    pair: [{ id: 'configure' }],
    settings: [
      conn([
        {
          id: 'operator', type: 'dropdown', label: t('Internet provider', 'Fournisseur d\'accès'), value: 'orange',
          values: [
            { id: 'orange', label: t('Orange (Livebox)', 'Orange (Livebox)') },
            { id: 'sosh', label: t('Sosh (Livebox)', 'Sosh (Livebox)') },
            { id: 'bouygues', label: t('Bouygues Telecom (Bbox)', 'Bouygues Telecom (Bbox)') },
            { id: 'sfr', label: t('SFR / RED by SFR (SFR Box)', 'SFR / RED by SFR (SFR Box)') },
          ],
        },
        { id: 'host', type: 'text', label: t('Box address', 'Adresse de la box'), value: '192.168.1.1',
          hint: t('Livebox and SFR Box: usually 192.168.1.1. Bbox: 192.168.1.254.', 'Livebox et SFR Box : en général 192.168.1.1. Bbox : 192.168.1.254.') },
        { id: 'username', type: 'text', label: t('User', 'Utilisateur'), value: 'admin' },
        {
          id: 'password', type: 'password', label: t('Administration password', 'Mot de passe d\'administration'), value: '',
          hint: t('Livebox: required (by default the first 8 characters of the Wi-Fi key printed under the box). Bbox and SFR Box: only if the box asks for it.',
            'Livebox : obligatoire (par défaut les 8 premiers caractères de la clé Wi-Fi inscrite sous la box). Bbox et SFR Box : seulement si la box le demande.'),
        },
        numberSetting('poll_interval', t('Polling interval', 'Intervalle d\'interrogation'), 60, 15, 600, 's',
          t('Traffic counters (Livebox, Bbox) are read every 10 s regardless of this value. SFR boxes do not expose them.',
            'Les compteurs de trafic (Livebox, Bbox) sont lus toutes les 10 s quelle que soit cette valeur. Les SFR Box ne les exposent pas.')),
      ]),
      {
        type: 'group', label: t('Fibre signal (Livebox)', 'Signal fibre (Livebox)'), children: [
          numberSetting('min_rx_power', t('Minimum received power', 'Puissance reçue minimum'), -26, -40, 0, 'dBm',
            t('GPON receivers work between -8 and -28 dBm; below -26 dBm the link is at risk (dirty connector, damaged fibre).',
              'Un récepteur GPON fonctionne entre -8 et -28 dBm ; sous -26 dBm la liaison est fragile (connecteur sale, fibre abîmée).')),
        ],
      },
      {
        type: 'group', label: t('Information', 'Informations'), children: [
          { id: 'model', type: 'label', label: t('Model', 'Modèle'), value: '' },
          { id: 'firmware', type: 'label', label: t('Firmware', 'Firmware'), value: '' },
        ],
      },
    ],
  },
  {
    id: 'deco',
    name: t('Deco node', 'Module Deco'),
    class: 'sensor',
    capabilities: ['netmon_rate', 'netmon_online', 'netmon_clients', 'netmon_latency', 'netmon_jitter', 'netmon_throughput.down', 'netmon_throughput.up', 'netmon_text'],
    capabilitiesOptions: {
      netmon_latency: opt(t('Latency from Homey (Wi-Fi mesh)', 'Latence depuis Homey (maillage Wi-Fi)')),
      netmon_jitter: opt(t('Jitter from Homey', 'Gigue depuis Homey')),
      netmon_online: opt(t('Online', 'En ligne')),
      netmon_text: opt(t('Backhaul', 'Liaison')),
      'netmon_throughput.down': opt(t('Download traffic (clients)', 'Trafic descendant (clients)')),
      'netmon_throughput.up': opt(t('Upload traffic (clients)', 'Trafic montant (clients)')),
      'netmon_online.internet': opt(t('Internet (Deco)', 'Internet (Deco)')),
      'netmon_clients.total': opt(t('Clients (network)', 'Clients (réseau)')),
      'netmon_clients.band24': opt(t('Clients 2.4 GHz', 'Clients 2,4 GHz')),
      'netmon_clients.band5': opt(t('Clients 5 GHz', 'Clients 5 GHz')),
      'netmon_clients.wired': opt(t('Wired clients', 'Clients filaires')),
      'netmon_load.cpu': opt(t('CPU', 'Processeur')),
      'netmon_load.mem': opt(t('Memory', 'Mémoire')),
      'netmon_signal.band5': opt(t('Backhaul signal 5 GHz', 'Signal de liaison 5 GHz')),
      'netmon_signal.band24': opt(t('Backhaul signal 2.4 GHz', 'Signal de liaison 2,4 GHz')),
    },
    platforms: ['local'],
    connectivity: ['lan'],
    images: images('deco'),
    pair: [{ id: 'configure' }],
    settings: [
      conn([
        { id: 'host', type: 'text', label: t('Main Deco address (connection)', 'Adresse du Deco principal (connexion)'), value: '',
          hint: t('All Deco devices connect through the main Deco. The address of this Deco is shown below.', 'Tous les modules Deco passent par le Deco principal. L\'adresse de ce Deco est indiquée plus bas.') },
        {
          id: 'password', type: 'password', label: t('Owner password', 'Mot de passe du propriétaire'), value: '',
          hint: t('Password of the TP-Link ID that owns the network. Manager accounts are refused by the Deco. Each login closes the owner session of the Deco mobile app: use a manager account in the app.',
            'Mot de passe de l\'ID TP-Link propriétaire du réseau. Les comptes gestionnaires sont refusés par le Deco. Chaque connexion ferme la session propriétaire de l\'app mobile Deco : utilisez un compte gestionnaire dans l\'app.'),
        },
        numberSetting('poll_interval', t('Polling interval', 'Intervalle d\'interrogation'), 60, 30, 600, 's',
          t('Shared by all Deco devices (the shortest interval is used).', 'Commun à tous les modules Deco (le plus court est utilisé).')),
      ]),
      {
        type: 'group', label: t('Mesh backhaul', 'Liaison maillée'), children: [
          numberSetting('min_signal', t('Minimum backhaul signal', 'Signal de liaison minimum'), 2, 0, 4, null,
            t('Wireless satellites only. Signal level reported by the Deco (0 = none to 4 = excellent).', 'Satellites sans fil uniquement. Niveau de signal donné par le Deco (0 = nul à 4 = excellent).')),
          numberSetting('min_speed', t('Minimum backhaul speed', 'Débit de liaison minimum'), 150, 0, 5000, 'Mbit/s', t('0 = no alert.', '0 = pas d\'alerte.')),
        ],
      },
      {
        type: 'group', label: t('Latency', 'Latence'), children: [
          numberSetting('max_latency', t('Latency warning above', 'Avertissement de latence au-delà de'), 50, 0, 2000, 'ms',
            t('Latency from Homey to this Deco, measured every poll (5 samples). For a satellite it includes the mesh backhaul. Above this value a warning is written to the diagnostic log. 0 = no warning.',
              'Latence entre la Homey et ce Deco, mesurée à chaque interrogation (5 mesures). Pour un satellite, elle inclut la liaison maillée. Au-delà de cette valeur, un avertissement est écrit dans le journal de diagnostic. 0 = pas d\'avertissement.')),
          numberSetting('latency_port', t('Measurement port', 'Port de mesure'), 80, 1, 65535, null,
            t('TCP port used for the measurement. An open or a closed port both answer: change it only if the Deco does not answer on 80.',
              'Port TCP utilisé pour la mesure. Un port ouvert ou fermé répond dans les deux cas : à changer seulement si le Deco ne répond pas sur le 80.')),
        ],
      },
      {
        type: 'group', label: t('Average traffic', 'Débit moyen'), children: [
          numberSetting('avg_window', t('Averaging window', 'Période de calcul de la moyenne'), 15, 1, 120, 'min',
            t('The "Average traffic" indicator (down / up) is the mean of the client traffic of this Deco over this period. Choose it as the device indicator to see it on the tile.',
              'L\'indicateur « Débit moyen » (descendant / montant) est la moyenne du trafic des clients de ce Deco sur cette période. Choisissez-le comme indicateur de l\'appareil pour l\'afficher sur la tuile.')),
        ],
      },
      {
        type: 'group', label: t('This Deco', 'Ce Deco'), children: [
          { id: 'node_ip', type: 'label', label: t('IP address', 'Adresse IP'), value: '' },
          { id: 'node_role', type: 'label', label: t('Role', 'Rôle'), value: '' },
          { id: 'node_mac', type: 'label', label: t('MAC address', 'Adresse MAC'), value: '' },
          { id: 'node_model', type: 'label', label: t('Model', 'Modèle'), value: '' },
          { id: 'node_firmware', type: 'label', label: t('Firmware', 'Firmware'), value: '' },
          {
            id: 'diag_rates', type: 'label', label: t('Traffic diagnostic', 'Diagnostic du trafic'), value: '',
            hint: t('Main Deco only: clients with a non-zero rate in the per-node lists / in the global list, then the fields returned by the firmware.',
              'Deco principal uniquement : clients avec un débit non nul dans les listes par module / dans la liste globale, puis les champs renvoyés par le firmware.'),
          },
        ],
      },
    ],
  },
];

// ------------------------------------------------------------------ flow
const dev = (id) => ({ type: 'device', name: 'device', filter: `driver_id=${id}` });
const tok = (name, type, title, example) => ({ name, type, title, example });
const flow = {
  triggers: [
    { id: 'internet_down', title: t('Internet went down', 'Internet est coupé'), hint: t('After the confirmation rounds set in the device.', 'Après le nombre de confirmations réglé dans l\'appareil.'),
      tokens: [tok('since', 'string', t('Since', 'Depuis'), '14:32'), tok('cause', 'string', t('Cause (internet / lan)', 'Cause (internet / lan)'), 'internet')], args: [dev('internet')] },
    { id: 'internet_restored', title: t('Internet is back', 'Internet est rétabli'),
      tokens: [tok('duration', 'number', t('Outage duration (s)', 'Durée de coupure (s)'), 95), tok('duration_text', 'string', t('Outage duration', 'Durée de coupure'), '1 min 35 s'), tok('since', 'string', t('Down since', 'Coupé depuis'), '14:32')],
      args: [dev('internet')] },
    { id: 'speedtest_done', title: t('A speed test finished', 'Un test de débit est terminé'),
      tokens: [tok('download', 'number', t('Download (Mbit/s)', 'Descendant (Mbit/s)'), 93.5), tok('upload', 'number', t('Upload (Mbit/s)', 'Montant (Mbit/s)'), 91.2),
        tok('latency', 'number', t('Latency (ms)', 'Latence (ms)'), 6.1), tok('jitter', 'number', t('Jitter (ms)', 'Gigue (ms)'), 0.8), tok('server', 'string', t('Server', 'Serveur'), 'MRS')],
      args: [dev('internet')] },
    { id: 'speedtest_failed', title: t('A speed test failed', 'Un test de débit a échoué'), tokens: [tok('error', 'string', t('Error', 'Erreur'), 'timeout')], args: [dev('internet')] },
    { id: 'quality_degraded', title: t('Connection quality degraded', 'La qualité de connexion s\'est dégradée'),
      hint: t('A threshold set in the device was crossed several times in a row.', 'Un seuil réglé dans l\'appareil a été franchi plusieurs fois de suite.'),
      tokens: [tok('metric', 'string', t('Measurement', 'Mesure'), 'Latence'), tok('value', 'number', t('Value', 'Valeur'), 48), tok('limit', 'number', t('Threshold', 'Seuil'), 30)],
      args: [dev('internet')] },
    { id: 'quality_recovered', title: t('Connection quality back to normal', 'La qualité de connexion est revenue à la normale'),
      tokens: [tok('metric', 'string', t('Measurement', 'Mesure'), 'Latence'), tok('value', 'number', t('Value', 'Valeur'), 7)],
      args: [dev('internet')] },

    { id: 'wan_down', title: t('Box Internet link went down', 'Le lien Internet de la box est tombé'), tokens: [tok('state', 'string', t('Line state', 'État de la ligne'), 'O1_Initial')], args: [dev('livebox')] },
    { id: 'wan_up', title: t('Box Internet link is back', 'Le lien Internet de la box est rétabli'), tokens: [tok('duration', 'number', t('Outage duration (s)', 'Durée de coupure (s)'), 300)], args: [dev('livebox')] },
    { id: 'wan_reconnected', title: t('Internet connection was renewed', 'La connexion Internet a été renouvelée'),
      hint: t('The connection uptime restarted from zero (reconnection by Orange or the box).', 'La durée de connexion est repartie de zéro (reconnexion par Orange ou par la box).'),
      tokens: [tok('previous', 'number', t('Previous uptime (h)', 'Durée précédente (h)'), 168.5)], args: [dev('livebox')] },
    { id: 'box_rebooted', title: t('The box rebooted', 'La box a redémarré'), tokens: [], args: [dev('livebox')] },
    { id: 'public_ip_changed', title: t('Public IP address changed', 'L\'adresse IP publique a changé'),
      tokens: [tok('ip', 'string', t('New IP', 'Nouvelle IP'), '90.1.2.3'), tok('previous', 'string', t('Previous IP', 'IP précédente'), '90.1.2.2')], args: [dev('livebox')] },
    { id: 'fiber_signal_low', title: t('Fibre signal too low', 'Signal fibre trop faible'), tokens: [tok('rx', 'number', t('Received power (dBm)', 'Puissance reçue (dBm)'), -27.1)], args: [dev('livebox')] },
    { id: 'fiber_signal_ok', title: t('Fibre signal back to normal', 'Signal fibre revenu à la normale'), tokens: [tok('rx', 'number', t('Received power (dBm)', 'Puissance reçue (dBm)'), -19.4)], args: [dev('livebox')] },

    { id: 'node_offline', title: t('Deco went offline', 'Le Deco est hors ligne'), tokens: [], args: [dev('deco')] },
    { id: 'node_online', title: t('Deco is back online', 'Le Deco est de nouveau en ligne'), tokens: [tok('duration', 'number', t('Offline duration (s)', 'Durée hors ligne (s)'), 120)], args: [dev('deco')] },
    { id: 'backhaul_weak', title: t('Mesh backhaul is weak', 'La liaison maillée est faible'),
      tokens: [tok('signal', 'number', t('Signal level', 'Niveau de signal'), 1), tok('speed', 'number', t('Speed (Mbit/s)', 'Débit (Mbit/s)'), 86)], args: [dev('deco')] },
    { id: 'backhaul_ok', title: t('Mesh backhaul back to normal', 'La liaison maillée est revenue à la normale'),
      tokens: [tok('signal', 'number', t('Signal level', 'Niveau de signal'), 3), tok('speed', 'number', t('Speed (Mbit/s)', 'Débit (Mbit/s)'), 480)], args: [dev('deco')] },
    { id: 'client_connected', title: t('A device connected to this Deco', 'Un appareil s\'est connecté à ce Deco'),
      tokens: [tok('name', 'string', t('Name', 'Nom'), 'iPhone'), tok('mac', 'string', t('MAC', 'MAC'), '11:22:33:44:55:66'), tok('ip', 'string', t('IP', 'IP'), '192.168.68.20'),
        tok('band', 'string', t('Connection', 'Connexion'), '5 GHz'), tok('network', 'string', t('Network', 'Réseau'), 'main')], args: [dev('deco')] },
    { id: 'client_disconnected', title: t('A device disconnected from this Deco', 'Un appareil s\'est déconnecté de ce Deco'),
      tokens: [tok('name', 'string', t('Name', 'Nom'), 'iPhone'), tok('mac', 'string', t('MAC', 'MAC'), '11:22:33:44:55:66')], args: [dev('deco')] },
  ],
  conditions: [
    { id: 'internet_is_online', title: t('Internet !{{is|is not}} available', 'Internet !{{est|n\'est pas}} disponible'), args: [dev('internet')] },
    { id: 'quality_is_ok', title: t('Connection quality !{{is|is not}} good', 'La qualité de connexion !{{est|n\'est pas}} bonne'),
      hint: t('Good = Internet available and no threshold alert in progress.', 'Bonne = Internet disponible et aucune alerte de seuil en cours.'), args: [dev('internet')] },
    { id: 'wan_is_up', title: t('Box Internet link !{{is|is not}} up', 'Le lien Internet de la box !{{est|n\'est pas}} actif'), args: [dev('livebox')] },
    { id: 'node_is_online', title: t('Deco !{{is|is not}} online', 'Le Deco !{{est|n\'est pas}} en ligne'), args: [dev('deco')] },
    { id: 'client_is_connected', title: t('A device named [[name]] !{{is|is not}} connected to the network', 'Un appareil nommé [[name]] !{{est|n\'est pas}} connecté au réseau'),
      titleFormatted: t('A device named [[name]] !{{is|is not}} connected to the network', 'Un appareil nommé [[name]] !{{est|n\'est pas}} connecté au réseau'),
      hint: t('Name (or part of it), IP or MAC address, as shown in the Deco app. Searches the whole mesh.', 'Nom (ou partie du nom), adresse IP ou MAC, tel qu\'affiché dans l\'app Deco. Recherche sur tout le réseau maillé.'),
      args: [dev('deco'), { type: 'text', name: 'name', placeholder: t('iPhone', 'iPhone') }] },
  ],
  actions: [
    { id: 'run_speedtest', title: t('Run a speed test', 'Lancer un test de débit'),
      hint: t('Results are set on the device and the "speed test finished" card is triggered.', 'Les résultats sont enregistrés sur l\'appareil et la carte « test de débit terminé » est déclenchée.'),
      args: [dev('internet')] },
    { id: 'run_speedtest_tokens', title: t('Run a speed test and return the results', 'Lancer un test de débit et renvoyer les résultats'),
      advanced: true,
      tokens: [tok('download', 'number', t('Download (Mbit/s)', 'Descendant (Mbit/s)'), 93.5), tok('upload', 'number', t('Upload (Mbit/s)', 'Montant (Mbit/s)'), 91.2), tok('latency', 'number', t('Latency (ms)', 'Latence (ms)'), 6.1)],
      args: [dev('internet')] },
  ],
};
// titleFormatted only for cards that use args in the title
delete flow.conditions[4].title;
flow.conditions[4].title = t('A device !{{is|is not}} connected to the network', 'Un appareil !{{est|n\'est pas}} connecté au réseau');

// ------------------------------------------------------------------ app
const manifest = {
  id: 'com.pepane13.netmonitor',
  version: pkg.version,
  compatibility: '>=12.2.0',
  sdk: 3,
  platforms: ['local'],
  name: t('Deco & Internet Monitor', 'Deco & Internet Monitor'),
  description: t('Monitor your Internet connection, your box (Orange, Sosh, Bouygues, SFR) and Deco Wi-Fi locally', 'Surveillez votre connexion Internet, votre box (Orange, Sosh, Bouygues, SFR) et votre Wi-Fi Deco en local'),
  category: ['internet'],
  permissions: [],
  images: { small: '/assets/images/small.png', large: '/assets/images/large.png', xlarge: '/assets/images/xlarge.png' },
  author: { name: 'Stéphane Renaudet', email: 'stephane.renaudet@gmail.com' },
  brandColor: '#1B6EC2',
  tags: {
    en: ['internet', 'network', 'speedtest', 'wifi', 'livebox', 'orange', 'sosh', 'bbox', 'bouygues', 'sfr', 'deco', 'tp-link', 'fibre', 'ping', 'latency', 'outage'],
    fr: ['internet', 'réseau', 'test de débit', 'wifi', 'livebox', 'orange', 'sosh', 'bbox', 'bouygues', 'sfr', 'deco', 'tp-link', 'fibre', 'ping', 'latence', 'coupure'],
  },
  source: 'https://github.com/Pepane13/homey-deco-internet-monitor',
  bugs: { url: 'https://github.com/Pepane13/homey-deco-internet-monitor/issues' },
  support: 'https://github.com/Pepane13/homey-deco-internet-monitor/issues',
  drivers,
  capabilities,
  flow,
  api: {
    getLog: { method: 'GET', path: '/log' },
    clearLog: { method: 'DELETE', path: '/log' },
    getStatus: { method: 'GET', path: '/status' },
    getReport: { method: 'GET', path: '/report' },
  },
};

fs.writeFileSync(path.join(APP, 'app.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`app.json written (${drivers.length} drivers, ${Object.keys(capabilities).length} capabilities, ${flow.triggers.length} triggers, ${flow.conditions.length} conditions, ${flow.actions.length} actions)`);
