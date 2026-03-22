const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractSignals } = require('../src/gep/signals');

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
