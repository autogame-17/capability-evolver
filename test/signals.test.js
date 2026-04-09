const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractSignals, _extractKeywordScore, _mergeSignals, SIGNAL_PROFILES, _extractRegex } = require('../src/gep/signals');

const emptyInput = {
  recentSessionTranscript: '',
  todayLog: '',
  memorySnippet: '',
  userSnippet: '',
  recentEvents: [],
};

function hasSignal(signals, name) {
  return Array.isArray(signals) && signals.some(s => String(s).startsWith(name));
}

function getSignalExtra(signals, name) {
  const s = Array.isArray(signals) ? signals.find(x => String(x).startsWith(name + ':')) : undefined;
  if (!s) return undefined;
  const i = String(s).indexOf(':');
  return i === -1 ? '' : String(s).slice(i + 1).trim();
}

describe('extractSignals -- user_feature_request (4 languages)', () => {
  it('recognizes English feature request', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'Please add a dark mode toggle to the settings page.',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request in ' + JSON.stringify(r));
  });

  it('recognizes Simplified Chinese feature request', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '加个支付模块，要支持微信和支付宝。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request in ' + JSON.stringify(r));
  });

  it('recognizes Traditional Chinese feature request', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '請加一個匯出報表的功能，要支援 PDF。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request in ' + JSON.stringify(r));
  });

  it('recognizes Japanese feature request', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'ダークモードのトグルを追加してほしいです。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request in ' + JSON.stringify(r));
  });

  it('user_feature_request signal carries snippet', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'Please add a dark mode toggle to the settings page.',
    });
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined, 'expected user_feature_request:extra form');
    assert.ok(extra.length > 0, 'extra should not be empty');
    assert.ok(extra.toLowerCase().includes('dark') || extra.includes('toggle') || extra.includes('add'), 'extra should reflect request content');
  });
});

describe('extractSignals -- user_improvement_suggestion (4 languages)', () => {
  it('recognizes English improvement suggestion', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'The UI could be better; we should simplify the onboarding flow.',
    });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'), 'expected user_improvement_suggestion in ' + JSON.stringify(r));
  });

  it('recognizes Simplified Chinese improvement suggestion', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '改进一下登录流程，优化一下性能。',
    });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'), 'expected user_improvement_suggestion in ' + JSON.stringify(r));
  });

  it('recognizes Traditional Chinese improvement suggestion', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '建議改進匯出速度，優化一下介面。',
    });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'), 'expected user_improvement_suggestion in ' + JSON.stringify(r));
  });

  it('recognizes Japanese improvement suggestion', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'ログインの流れを改善してほしい。',
    });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'), 'expected user_improvement_suggestion in ' + JSON.stringify(r));
  });

  it('user_improvement_suggestion signal carries snippet', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'We should refactor the payment module and simplify the API.',
    });
    const extra = getSignalExtra(r, 'user_improvement_suggestion');
    assert.ok(extra !== undefined, 'expected user_improvement_suggestion:extra form');
    assert.ok(extra.length > 0, 'extra should not be empty');
  });
});

describe('extractSignals -- edge cases (snippet length, empty, punctuation)', () => {
  it('long snippet truncated to 200 chars', () => {
    const long = '我想让系统支持批量导入用户、导出报表、自定义工作流、多语言切换、主题切换、权限组、审计日志、Webhook 通知、API 限流、缓存策略配置、数据库备份恢复、灰度发布、A/B 测试、埋点统计、性能监控、告警规则、工单流转、知识库搜索、智能推荐、以及一大堆其他功能以便我们能够更好地管理业务。';
    const r = extractSignals({ ...emptyInput, userSnippet: long });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request');
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined && extra.length > 0, 'extra should be present');
    assert.ok(extra.length <= 200, 'snippet must be truncated to 200 chars, got ' + extra.length);
  });

  it('short snippet works', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '我想加一个导出 Excel 的功能。' });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined && extra.length > 0);
  });

  it('bare "我想。" still triggers', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '我想。' });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request for 我想。');
  });

  it('bare "我想" without punctuation still triggers', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '我想' });
    assert.ok(hasSignal(r, 'user_feature_request'));
  });

  it('empty userSnippet does not produce feature/improvement', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '' });
    const hasFeat = hasSignal(r, 'user_feature_request');
    const hasImp = hasSignal(r, 'user_improvement_suggestion');
    assert.ok(!hasFeat && !hasImp, 'empty userSnippet should not yield feature/improvement from user input');
  });

  it('whitespace/punctuation only does not match', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '   \n\t  。，、  \n' });
    assert.ok(!hasSignal(r, 'user_feature_request'), 'whitespace/punctuation only should not match');
    assert.ok(!hasSignal(r, 'user_improvement_suggestion'));
  });

  it('English "I want" long snippet truncated', () => {
    const long = 'I want to add a feature that allows users to export data in CSV and Excel formats, with custom column mapping, date range filters, scheduled exports, email delivery, and integration with our analytics pipeline so that we can reduce manual reporting work. This is critical for Q2.';
    const r = extractSignals({ ...emptyInput, userSnippet: long });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra === undefined || extra.length <= 200, 'snippet if present should be <= 200');
  });

  it('improvement snippet truncated to 200', () => {
    const long = '改进一下登录流程：首先支持扫码登录、然后记住设备、然后支持多因素认证、然后审计日志、然后限流防刷、然后国际化提示、然后无障碍优化、然后性能优化、然后安全加固、然后文档补全。';
    const r = extractSignals({ ...emptyInput, userSnippet: long });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'));
    const extra = getSignalExtra(r, 'user_improvement_suggestion');
    assert.ok(extra !== undefined && extra.length > 0);
    assert.ok(extra.length <= 200, 'improvement snippet <= 200, got ' + extra.length);
  });

  it('mixed sentences: feature request detected with snippet', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '加个支付模块，要支持微信和支付宝。另外昨天那个 bug 修了吗？',
    });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined && extra.length > 0);
  });

  it('newlines and tabs in text: regex matches and normalizes', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '我想\n加一个\t导出\n报表的功能。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined);
    assert.ok(!/\n/.test(extra) || extra.length <= 200, 'snippet should be normalized');
  });

  it('"我想" in middle of paragraph still triggers', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '前面是一些背景说明。我想加一个暗色模式开关，方便夜间使用。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined && extra.length > 0);
  });

  it('pure punctuation does not trigger', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '。。。。' });
    assert.ok(!hasSignal(r, 'user_feature_request'));
    assert.ok(!hasSignal(r, 'user_improvement_suggestion'));
  });

  it('both feature_request and improvement_suggestion carry snippets', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '加个支付模块。另外改进一下登录流程，简化步骤。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'));
    assert.ok(hasSignal(r, 'user_improvement_suggestion'));
    assert.ok(getSignalExtra(r, 'user_feature_request'));
    assert.ok(getSignalExtra(r, 'user_improvement_suggestion'));
  });
});

describe('extractSignals -- windows_shell_incompatible', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  function setPlatform(value) {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  function restorePlatform() {
    Object.defineProperty(process, 'platform', originalPlatform);
  }

  it('detects pgrep on win32', () => {
    setPlatform('win32');
    try {
      const r = extractSignals({
        ...emptyInput,
        recentSessionTranscript: 'Running pgrep -f evolver to check processes',
      });
      assert.ok(hasSignal(r, 'windows_shell_incompatible'), 'expected windows_shell_incompatible for pgrep on win32');
    } finally {
      restorePlatform();
    }
  });

  it('detects ps aux on win32', () => {
    setPlatform('win32');
    try {
      const r = extractSignals({
        ...emptyInput,
        recentSessionTranscript: 'Output of ps aux shows running processes',
      });
      assert.ok(hasSignal(r, 'windows_shell_incompatible'), 'expected windows_shell_incompatible for ps aux on win32');
    } finally {
      restorePlatform();
    }
  });

  it('detects cat > redirect on win32', () => {
    setPlatform('win32');
    try {
      const r = extractSignals({
        ...emptyInput,
        recentSessionTranscript: 'Use cat > output.json to write the file',
      });
      assert.ok(hasSignal(r, 'windows_shell_incompatible'), 'expected windows_shell_incompatible for cat > on win32');
    } finally {
      restorePlatform();
    }
  });

  it('detects heredoc on win32', () => {
    setPlatform('win32');
    try {
      const r = extractSignals({
        ...emptyInput,
        recentSessionTranscript: 'Use a heredoc to write multiline content',
      });
      assert.ok(hasSignal(r, 'windows_shell_incompatible'), 'expected windows_shell_incompatible for heredoc on win32');
    } finally {
      restorePlatform();
    }
  });

  it('does NOT detect on linux even with matching content', () => {
    setPlatform('linux');
    try {
      const r = extractSignals({
        ...emptyInput,
        recentSessionTranscript: 'Running pgrep -f evolver and ps aux and cat > file',
      });
      assert.ok(!hasSignal(r, 'windows_shell_incompatible'), 'should not flag on linux');
    } finally {
      restorePlatform();
    }
  });

  it('does NOT detect on darwin even with matching content', () => {
    setPlatform('darwin');
    try {
      const r = extractSignals({
        ...emptyInput,
        recentSessionTranscript: 'Running pgrep -f evolver',
      });
      assert.ok(!hasSignal(r, 'windows_shell_incompatible'), 'should not flag on darwin');
    } finally {
      restorePlatform();
    }
  });

  it('is treated as cosmetic and dropped when actionable signals exist', () => {
    setPlatform('win32');
    try {
      const r = extractSignals({
        ...emptyInput,
        recentSessionTranscript: 'Running pgrep -f evolver',
        todayLog: 'ERROR: connection refused to database',
      });
      assert.ok(!hasSignal(r, 'windows_shell_incompatible'),
        'cosmetic signal should be dropped when actionable signals exist, got: ' + JSON.stringify(r));
    } finally {
      restorePlatform();
    }
  });
});

// ===========================================================================
// Multi-strategy signal extraction tests
// ===========================================================================

describe('_extractKeywordScore -- weighted keyword scoring (Layer 2)', () => {
  it('SIGNAL_PROFILES is defined with expected keys', () => {
    assert.ok(typeof SIGNAL_PROFILES === 'object');
    assert.ok('perf_bottleneck' in SIGNAL_PROFILES);
    assert.ok('capability_gap' in SIGNAL_PROFILES);
    assert.ok('user_feature_request' in SIGNAL_PROFILES);
    assert.ok('user_improvement_suggestion' in SIGNAL_PROFILES);
    assert.ok('recurring_error' in SIGNAL_PROFILES);
    assert.ok('tool_bypass' in SIGNAL_PROFILES);
    assert.ok('evolution_stagnation_detected' in SIGNAL_PROFILES);
  });

  it('each profile has keywords and threshold', () => {
    for (const [name, profile] of Object.entries(SIGNAL_PROFILES)) {
      assert.ok(typeof profile.keywords === 'object', name + ' missing keywords');
      assert.ok(typeof profile.threshold === 'number' && profile.threshold > 0, name + ' missing valid threshold');
      assert.ok(Object.keys(profile.keywords).length > 0, name + ' has empty keywords');
    }
  });

  it('detects perf_bottleneck from accumulated keywords', () => {
    const corpus = 'the system is slow and has high latency, queries timeout frequently and the bottleneck is the database';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(r.includes('perf_bottleneck'), 'expected perf_bottleneck, got ' + JSON.stringify(r));
  });

  it('does not fire perf_bottleneck on a single weak keyword', () => {
    const corpus = 'there was a minor delay in the response';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(!r.includes('perf_bottleneck'), 'single weak keyword should not fire perf_bottleneck');
  });

  it('detects capability_gap from accumulated keywords', () => {
    const corpus = 'this feature is not supported and the API is not available for this use case. it is not implemented.';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(r.includes('capability_gap'), 'expected capability_gap, got ' + JSON.stringify(r));
  });

  it('detects user_feature_request from accumulated keywords', () => {
    const corpus = 'we need to implement a new feature, i want to add support for the endpoint, please add a new capability';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(r.includes('user_feature_request'), 'expected user_feature_request, got ' + JSON.stringify(r));
  });

  it('detects user_improvement_suggestion from keywords', () => {
    const corpus = 'we should improve the codebase, refactor the module, and streamline the process to be more efficient';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(r.includes('user_improvement_suggestion'), 'expected user_improvement_suggestion, got ' + JSON.stringify(r));
  });

  it('detects recurring_error from keywords', () => {
    const corpus = 'the same error keeps happening repeatedly, it crashed again, still failing after the fix, exception not fixed';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(r.includes('recurring_error'), 'expected recurring_error, got ' + JSON.stringify(r));
  });

  it('detects evolution_stagnation_detected from keywords', () => {
    const corpus = 'no change in the output, same result every time, stuck on this plateau with no progress at all';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(r.includes('evolution_stagnation_detected'), 'expected evolution_stagnation_detected, got ' + JSON.stringify(r));
  });

  it('returns empty for neutral text', () => {
    const corpus = 'the sun is shining today and the weather is nice. the cat sat on the mat.';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(r.length === 0, 'neutral text should not trigger signals, got ' + JSON.stringify(r));
  });

  it('can fire multiple signals from mixed corpus', () => {
    const corpus = 'the system is slow with high latency timeout. also this feature is not supported and not implemented.';
    const r = _extractKeywordScore(corpus.toLowerCase());
    assert.ok(r.includes('perf_bottleneck'), 'expected perf_bottleneck');
    assert.ok(r.includes('capability_gap'), 'expected capability_gap');
  });
});

describe('_mergeSignals -- signal merge and dedup', () => {
  it('merges three non-overlapping arrays', () => {
    const r = _mergeSignals(['a', 'b'], ['c', 'd'], ['e']);
    assert.deepStrictEqual(r.sort(), ['a', 'b', 'c', 'd', 'e']);
  });

  it('deduplicates across layers', () => {
    const r = _mergeSignals(['a', 'b'], ['b', 'c'], ['c', 'd']);
    assert.deepStrictEqual(r.sort(), ['a', 'b', 'c', 'd']);
  });

  it('handles empty arrays', () => {
    const r = _mergeSignals([], [], []);
    assert.deepStrictEqual(r, []);
  });

  it('single-layer only', () => {
    const r = _mergeSignals(['x', 'y'], [], []);
    assert.deepStrictEqual(r.sort(), ['x', 'y']);
  });
});

describe('_extractRegex -- Layer 1 isolation', () => {
  it('detects log_error when errorHit is true', () => {
    const corpus = 'some content';
    const r = _extractRegex(corpus, corpus.toLowerCase(), true);
    assert.ok(r.includes('log_error'));
  });

  it('does not detect log_error when errorHit is false', () => {
    const corpus = 'everything is fine';
    const r = _extractRegex(corpus, corpus.toLowerCase(), false);
    assert.ok(!r.includes('log_error'));
  });

  it('detects memory_missing', () => {
    const corpus = 'Warning: memory.md missing';
    const r = _extractRegex(corpus, corpus.toLowerCase(), false);
    assert.ok(r.includes('memory_missing'));
  });

  it('detects perf_bottleneck via regex', () => {
    const corpus = 'The query has a timeout and is too slow';
    const r = _extractRegex(corpus, corpus.toLowerCase(), false);
    assert.ok(r.includes('perf_bottleneck'));
  });
});

describe('extractSignals -- multi-strategy integration', () => {
  it('keyword-scoring adds signals that regex misses', () => {
    // Corpus with multiple weak perf keywords that individually might not
    // match the regex pattern but collectively exceed the scoring threshold.
    const r = extractSignals({
      ...emptyInput,
      todayLog: 'request had lag and delay, the system felt sluggish with throttle. performance was degraded.',
    });
    assert.ok(hasSignal(r, 'perf_bottleneck'),
      'keyword scoring should detect perf_bottleneck from accumulated weak keywords, got ' + JSON.stringify(r));
  });

  it('all signals are deduplicated in final output', () => {
    const r = extractSignals({
      ...emptyInput,
      todayLog: 'Error: connection timeout\nThe system is slow with high latency and bottleneck.',
    });
    const counts = {};
    for (const s of r) {
      const key = s.split(':')[0];
      counts[key] = (counts[key] || 0) + 1;
    }
    for (const [key, count] of Object.entries(counts)) {
      if (key === 'errsig' || key === 'user_feature_request' || key === 'user_improvement_suggestion') continue;
      assert.ok(count === 1, key + ' appeared ' + count + ' times (should be 1)');
    }
  });
});
