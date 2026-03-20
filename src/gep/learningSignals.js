// Structured learning signal expansion: raw signals -> categorized tags for gene selection and evolution feedback.
function unique(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).filter(Boolean).map(function (x) {
    return String(x).trim();
  }).filter(Boolean)));
}

function add(tags, value) {
  if (!value) return;
  tags.push(String(value).trim());
}

function expandSignals(signals, extraText) {
  const raw = Array.isArray(signals) ? signals.map(function (s) { return String(s); }) : [];
  const tags = [];

  for (let i = 0; i < raw.length; i++) {
    const signal = raw[i];
    add(tags, signal);
    const base = signal.split(':')[0];
    if (base && base !== signal) add(tags, base);
  }

  const text = (raw.join(' ') + ' ' + String(extraText || '')).toLowerCase();

  if (/(error|exception|failed|unstable|log_error|runtime|429)/.test(text)) {
    add(tags, 'problem:reliability');
    add(tags, 'action:repair');
  }
  if (/(protocol|prompt|audit|gep|schema|drift)/.test(text)) {
    add(tags, 'problem:protocol');
    add(tags, 'action:optimize');
    add(tags, 'area:prompt');
  }
  if (/(perf|performance|bottleneck|latency|slow|throughput)/.test(text)) {
    add(tags, 'problem:performance');
    add(tags, 'action:optimize');
  }
  if (/(feature|capability_gap|user_feature_request|external_opportunity|stagnation recommendation)/.test(text)) {
    add(tags, 'problem:capability');
    add(tags, 'action:innovate');
  }
  if (/(stagnation|plateau|steady_state|saturation|empty_cycle_loop|loop_detected|recurring)/.test(text)) {
    add(tags, 'problem:stagnation');
    add(tags, 'action:innovate');
  }
  if (/(task|worker|heartbeat|hub|commitment|assignment|orchestration)/.test(text)) {
    add(tags, 'area:orchestration');
  }
  if (/(memory|narrative|reflection)/.test(text)) {
    add(tags, 'area:memory');
  }
  if (/(skill|dashboard)/.test(text)) {
    add(tags, 'area:skills');
  }
  if (/(validation|canary|rollback|constraint|blast radius|destructive)/.test(text)) {
    add(tags, 'risk:validation');
  }

  return unique(tags);
}

function geneTags(gene) {
  if (!gene || typeof gene !== 'object') return [];
  let inputs = [];
  if (gene.category) inputs.push('action:' + String(gene.category).toLowerCase());
  if (Array.isArray(gene.signals_match)) inputs = inputs.concat(gene.signals_match);
  if (typeof gene.id === 'string') inputs.push(gene.id);
  if (typeof gene.summary === 'string') inputs.push(gene.summary);
  return expandSignals(inputs, '');
}

function scoreTagOverlap(gene, signals) {
  const signalTags = expandSignals(signals, '');
  const geneTagList = geneTags(gene);
  if (signalTags.length === 0 || geneTagList.length === 0) return 0;
  const signalSet = new Set(signalTags);
  let hits = 0;
  for (let i = 0; i < geneTagList.length; i++) {
    if (signalSet.has(geneTagList[i])) hits++;
  }
  return hits;
}

module.exports = {
  expandSignals: expandSignals,
  geneTags: geneTags,
  scoreTagOverlap: scoreTagOverlap,
};
