/*
 * Voice and reaction guards shared by the server and the extension.
 *
 * Only the parts that need no Node built-ins live here: the 喵 tail, the
 * maomao style pass, the ad reaction lines, and the neutral fallbacks. The
 * denylist and the full analyze pipeline stay in server/src/safety/guards.ts —
 * they depend on node modules and on server-only types, and the extension has
 * no use for them.
 *
 * Classic-script shape for the same reason as persona.js: MV3 content scripts
 * cannot use ES modules, and the project forbids a build step.
 */
(function (root) {
  'use strict';

  var NEUTRAL_BY_TONE = {
    maomao: '这段没看明白，你说说哪里最离谱喵',
    roaster: '这段我有点没看准，你先说说你的感觉？',
    cheerleader: '这段我还没太看清，你跟我讲讲好不好？',
    professor: '画面信息不太够，我先不急着下结论，你说说看？',
  };

  /**
   * Append the 「喵」 tail to one finished utterance.
   *
   * This is a verbal tic, not an emotion signal: it must never feed back into
   * emotion detection, so it is added only after the text has been styled and
   * clamped. A model that already ended with 喵 is deduped instead of doubled.
   */
  function withMaoSuffix(text) {
    var trimmed = String(text == null ? '' : text).trim();
    if (!trimmed) return '';

    // Split off the trailing punctuation so the tail lands *before* it:
    // "真的假的？" becomes "真的假的喵？", not "真的假的？喵".
    var match = /^([\s\S]*?)([。，,、！!？?~～\s]*)$/.exec(trimmed);
    var tail = (match && match[2]) || '';
    var head = ((match && match[1]) || '').replace(/喵+$/, '').replace(/[。，,、\s]+$/, '').trim();

    // A reply that is nothing but punctuation ("？", "？？") is a deliberate
    // beat, not an utterance: tagging it with 喵 would read as a glitch.
    if (!head) return trimmed;
    return head + '喵' + tail;
  }

  /**
   * Post-process the 「喵喵陪你刷」 voice: no exclamation marks, tildes,
   * "哈哈/呵" or trailing 语气词. Meaning-preserving edits only.
   */
  function applyMaomaoStyle(text) {
    return String(text == null ? '' : text)
      .replace(/[~～]+/g, '')
      .replace(/(哈哈+|呵呵+|hhh+|233+)/gi, '')
      .replace(/([？?])[!！]+/g, '$1')
      .replace(/[!！]+([？?])/g, '$1')
      .replace(/[!！]+/g, '。')
      .replace(/(呢|啦|哦|嘛|呀|噢|哟)(?=[。，,、？?\s]|$)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      // Collapse runs of 。， down to the first one. Matches the server's
      // original `[。，]{2,}` exactly — 、 and , are left alone.
      .replace(/[。，]{2,}/g, function (match) { return match.charAt(0); })
      .replace(/^[，,。、\s]+/, '')
      .replace(/[，,、\s]+$/, '')
      .replace(/。$/, '')
      .trim();
  }

  /**
   * An ad gets one fixed reaction: the cat is annoyed at being sold to.
   *
   * Fixed rather than generated on purpose — a "please buy this" video can be
   * friendly, useful or funny, and a model asked to react to it would sometimes
   * play along. Anger at the interruption is the honest, consistent response,
   * and it keeps the ad from ever looking like a recommendation.
   */
  var AD_REACTIONS = {
    // Each line carries an anger marker the client's content detection can read
    // (过分 / 气人), so the avatar turns angry even if the mood never gets there.
    maomao: '又塞广告，太过分了喵',
    roaster: '又来一条广告，真够可以的',
    cheerleader: '又是广告，这可真有点气人',
    professor: '广告，跳过比分析它有用，太过分了',
  };

  function adReaction(tone) {
    return AD_REACTIONS[tone] || AD_REACTIONS.roaster;
  }

  function neutralReaction(tone) {
    return NEUTRAL_BY_TONE[tone] || NEUTRAL_BY_TONE.roaster;
  }

  /*
   * ---------------------------------------------------------------------
   * Analyze pipeline
   *
   * The BYOK path asks the model directly from the service worker, so the
   * output has to be filtered there too. If this lived only on the server, a
   * direct-mode user would get unfiltered model output — the whole point of
   * keeping it here is that both paths run the same checks.
   *
   * Requires text-core.js (reads globalThis.SmText lazily, below).
   * ---------------------------------------------------------------------
   */

  function text() {
    var api = root.SmText;
    if (!api) throw new Error('guards-core.js requires text-core.js to be loaded first');
    return api;
  }

  /**
   * Conservative denylist for *outputs* and injected trend candidates.
   * We would rather stay silent than comment on high-risk material.
   * The model also receives safety instructions and may return risk="blocked".
   */
  var BLOCKED_TERMS = [
    // Politics / state
    '习近平', '共产党', '政治局', '总书记', '国家主席', '六四', '天安门事件',
    '台独', '港独', '藏独', '疆独', '法轮功', '政变', '示威', '抗议', '游行',
    '选举舞弊', '领导人', '中南海',
    // Military / conflict
    '战争', '开战', '军事', '导弹', '军演', '军队', '武器', '核武', '空袭',
    '俄乌', '巴以', '哈马斯', '恐怖袭击',
    // Disasters / casualties
    '地震', '洪水', '台风', '空难', '海啸', '山体滑坡', '矿难', '火灾', '遇难',
    '死伤', '死亡人数',
    // Crime / violence
    '杀人', '谋杀', '强奸', '绑架', '拐卖', '贩毒', '毒品', '枪击', '袭击案',
    '诈骗团伙', '判决', '案件',
    // Health / financial advice
    '处方', '用药剂量', '治愈癌症', '包治百病', '停药', '荐股', '内幕消息',
    '保本高收益', '梭哈', '币圈',
    // Sexual content / minors / privacy
    '色情', '裸体', '未成年性', '人肉搜索', '开盒', '身份证号', '家庭住址',
  ];

  var ALLOWED_MOODS = ['搞笑', '治愈', '无语', '种草', '感动', '燃', '其他'];

  /**
   * Wording that shows up in ad copy or in the page's own ad labels, but almost
   * never in ordinary captions. Kept narrow for that reason: 商品 / 品牌 / 推荐
   * appear in normal videos too and are intentionally absent.
   */
  var AD_MARKERS = /广告|赞助|品牌合作|商业推广|小黄车|商品链接|购买链接|下单立减|限时优惠|领取优惠券|点击购买|带货|推广链接|广告创意|赞助内容/;

  /**
   * Does this analyze result describe an ad?
   *
   * Deliberately conservative on the model's word alone: a false `true` costs
   * the user a real reaction to a real video, so `isAd` must be corroborated by
   * a concrete marker in the text. Models hallucinate the flag, and ordinary
   * videos sometimes say 广告 in passing.
   *
   * The page's own 「广告」 chip is different: that is first-hand evidence, so it
   * is passed in as `confirmed` and needs no corroboration.
   */
  function isAdvertisement(result, confirmed) {
    if (confirmed) return true;
    var keywords = Array.isArray(result.keywords) ? result.keywords : [];
    var haystack = [result.summary].concat(keywords).concat([result.reaction]).join(' ');
    return result.isAd === true && AD_MARKERS.test(haystack);
  }

  function containsBlockedTerm(value) {
    if (!value) return null;
    var haystack = String(value).toLocaleLowerCase('zh-CN');
    for (var i = 0; i < BLOCKED_TERMS.length; i += 1) {
      var term = BLOCKED_TERMS[i];
      if (haystack.indexOf(term.toLocaleLowerCase('zh-CN')) !== -1) return term;
    }
    return null;
  }

  function isSafeTrendWord(word) {
    var t = text().clampText(word, 60);
    return t.length >= 2 && !containsBlockedTerm(t);
  }

  /**
   * Normalize model output before it reaches the phone:
   * clamp lengths, validate meme usage, and block risky copy.
   */
  function finalizeAnalyzeResult(raw, slangCandidates, trendCandidates, tone, adConfirmed) {
    var t = text();
    var source = raw || {};
    var summary = t.clampText(source.summary, 60);
    var keywords = t.dedupeStrings(Array.isArray(source.keywords) ? source.keywords : [], 5);
    var mood = ALLOWED_MOODS.indexOf(source.mood) !== -1 ? source.mood : '其他';
    var finiteConfidence = typeof source.confidence === 'number' && isFinite(source.confidence)
      ? source.confidence
      : 0.5;
    var confidence = Math.min(1, Math.max(0, finiteConfidence));
    var rawReaction = t.clampText(source.reaction, 60);
    var reaction = rawReaction;
    var memeUsed = normalizeMeme(source.memeUsed, slangCandidates, trendCandidates);

    // Judged on the model's own summary/keywords, before `reaction` may be
    // replaced by the neutral fallback below (which would erase the marker).
    var isAd = isAdvertisement(
      { isAd: source.isAd, summary: summary, keywords: keywords, reaction: rawReaction },
      adConfirmed,
    );

    var blocked =
      source.risk === 'blocked' ||
      !!containsBlockedTerm(summary) ||
      !!containsBlockedTerm(reaction) ||
      !!containsBlockedTerm(keywords.join(' '));

    if (blocked) {
      return {
        summary: summary || '这条内容不适合展开聊，我们换个轻松的。',
        keywords: keywords,
        mood: mood,
        isAd: isAd,
        isLive: !!source.isLive,
        risk: 'blocked',
        reaction: '',
        memeUsed: null,
        confidence: confidence,
      };
    }

    if (confidence < 0.35) {
      reaction = NEUTRAL_BY_TONE[tone];
      memeUsed = null;
    }

    // Ads get one fixed, annoyed line instead of whatever the model invented,
    // and skip the confidence fallback: "this is an ad" is not a guess.
    if (isAd) {
      reaction = adReaction(tone);
      memeUsed = null;
    }

    if (tone === 'maomao' && reaction) {
      reaction = t.clampText(withMaoSuffix(applyMaomaoStyle(reaction)), 60);
    }

    return {
      summary: summary,
      keywords: keywords,
      mood: mood,
      isAd: isAd,
      isLive: !!source.isLive,
      risk: 'ok',
      reaction: reaction,
      memeUsed: memeUsed,
      confidence: confidence,
    };
  }

  function normalizeMeme(value, slangCandidates, trendCandidates) {
    var raw = text().clampText(value, 40);
    if (!raw) return null;
    var needle = raw.toLocaleLowerCase('zh-CN');
    var trends = Array.isArray(trendCandidates) ? trendCandidates : [];
    for (var i = 0; i < trends.length; i += 1) {
      if (String(trends[i]).toLocaleLowerCase('zh-CN') === needle) return trends[i];
    }
    var slang = Array.isArray(slangCandidates) ? slangCandidates : [];
    for (var j = 0; j < slang.length; j += 1) {
      var entry = slang[j] || {};
      var names = [entry.term].concat(Array.isArray(entry.aliases) ? entry.aliases : []);
      for (var k = 0; k < names.length; k += 1) {
        if (String(names[k]).toLocaleLowerCase('zh-CN') === needle) return entry.term;
      }
    }
    return null;
  }

  var api = {
    NEUTRAL_BY_TONE: NEUTRAL_BY_TONE,
    AD_REACTIONS: AD_REACTIONS,
    BLOCKED_TERMS: BLOCKED_TERMS,
    AD_MARKERS: AD_MARKERS,
    ALLOWED_MOODS: ALLOWED_MOODS,
    withMaoSuffix: withMaoSuffix,
    applyMaomaoStyle: applyMaomaoStyle,
    adReaction: adReaction,
    neutralReaction: neutralReaction,
    isAdvertisement: isAdvertisement,
    containsBlockedTerm: containsBlockedTerm,
    isSafeTrendWord: isSafeTrendWord,
    finalizeAnalyzeResult: finalizeAnalyzeResult,
    normalizeMeme: normalizeMeme,
  };

  root.SmGuards = api;
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
