/* 猫娘悬浮球 · 9 情绪映射 / 轮转控制
 *
 * 浏览器：window.BuddyEmotions（同时保留 window.CatEmotions 兼容）
 * Node：  require('./emotions.js')
 *
 * 聊天/情绪识别结果只要返回 id 或 aliases 中的任意一个，
 * 调用 ui.setEmotion(result) 即可切换图标。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.BuddyEmotions = factory();
    root.CatEmotions = root.BuddyEmotions;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var EMOTIONS = {
    sad: {
      id: "sad", label: "委屈", en: "sad",
      desc: "难过、委屈、想被安慰",
      keywords: ["难过", "委屈", "想哭", "呜呜", "失落", "不开心", "伤心", "哭", "心疼", "可怜", "难受", "心酸", "破防", "低落"],
      aliases: ["sad", "sadness", "upset", "难过", "委屈"],
      valence: -0.6, arousal: 0.25
    },
    happy: {
      id: "happy", label: "开心", en: "happy",
      desc: "开心、认可、被夸",
      keywords: ["开心", "高兴", "好耶", "喜欢", "谢谢", "太好了", "赞", "不错", "还行", "挺好", "有点意思", "有眼光", "满意", "舒服"],
      aliases: ["happy", "joy", "glad", "开心", "高兴"],
      valence: 0.8, arousal: 0.55
    },
    annoyed: {
      id: "annoyed", label: "嫌弃", en: "annoyed",
      desc: "无语、嫌弃、不耐烦",
      keywords: ["无语", "离谱", "烦", "随便", "啧", "不想理", "嫌弃", "服了", "别装", "懒得", "看不下去", "什么玩意", "差不多得了", "少来", "这也能"],
      aliases: ["annoyed", "disgust", "disgusted", "嫌弃", "无语"],
      valence: -0.4, arousal: 0.45
    },
    angry: {
      id: "angry", label: "生气", en: "angry",
      desc: "生气、炸毛、恼火",
      keywords: ["生气", "气死", "讨厌", "过分", "可恶", "滚", "恼火", "火大", "气人", "欠", "找骂", "别逼"],
      aliases: ["angry", "anger", "mad", "生气", "炸毛"],
      valence: -0.8, arousal: 0.9
    },
    laugh: {
      id: "laugh", label: "大笑", en: "laugh",
      desc: "被逗乐、大笑、绷不住",
      keywords: ["哈哈", "笑死", "搞笑", "绷不住", "乐死", "233", "笑不活", "好笑", "笑喷", "好活", "绝了", "真行", "真把自己当"],
      aliases: ["laugh", "laughing", "amused", "大笑", "好笑"],
      valence: 0.9, arousal: 0.8
    },
    excited: {
      id: "excited", label: "兴奋", en: "excited",
      desc: "期待、激动、想立刻开始",
      keywords: ["期待", "激动", "冲", "太棒了", "迫不及待", "等不及", "好激动", "带劲", "来劲", "想看", "好家伙"],
      aliases: ["excited", "excitement", "thrilled", "兴奋", "期待"],
      valence: 0.9, arousal: 0.9
    },
    greet: {
      id: "greet", label: "打招呼", en: "greet",
      desc: "友好、打招呼、初次见面",
      keywords: ["你好", "在吗", "嗨", "早上好", "晚安", "一起看", "陪我", "hello", "hi", "我在", "来了"],
      aliases: ["greet", "greeting", "friendly", "打招呼", "友好"],
      valence: 0.6, arousal: 0.4
    },
    confused: {
      id: "confused", label: "疑惑", en: "confused",
      desc: "疑惑、思考、没听懂",
      keywords: ["为什么", "啥", "不懂", "真的吗", "什么意思", "啊？", "疑惑", "没懂", "没看懂", "什么逻辑", "搞不懂", "你确定", "问号", "啊这"],
      aliases: ["confused", "confusion", "puzzled", "疑惑", "困惑"],
      valence: -0.05, arousal: 0.4
    },
    shocked: {
      id: "shocked", label: "震惊", en: "shocked",
      desc: "震惊、不敢相信、崩溃",
      keywords: ["震惊", "天哪", "不会吧", "真的假的", "卧槽", "崩溃", "救命", "不是吧", "真敢", "没想到", "活久见"],
      aliases: ["shocked", "shock", "surprised", "surprise", "震惊", "吃惊"],
      valence: -0.3, arousal: 0.95
    }
  };

  var ORDER = ["sad", "happy", "annoyed", "angry", "laugh", "excited", "greet", "confused", "shocked"];
  var DEFAULT = "greet";
  var ICON_DIR = "assets/emotions";
  var MOOD_MAP = {
    "搞笑": "laugh",
    "治愈": "happy",
    "无语": "annoyed",
    "种草": "excited",
    "感动": "sad",
    "燃": "excited",
    "其他": "greet",
    "生气": "angry",
    "震惊": "shocked",
    "疑惑": "confused"
  };

  // AI replies often express an attitude without naming an emotion. These
  // patterns are only used when no explicit keyword matched, so they broaden
  // coverage without overriding a stronger signal.
  var TONE_RULES = [
    { id: "annoyed", re: /(服了|无语|就这(?=[?？。！!]|$)|别装|懒得|看不下去|什么玩意|差不多得了|少来|别找原因|就是饵|喂熟了|刷点不一样的|就摆在那|等它自己解释|就这么点事|没救|你这话说得.*正常)/ },
    { id: "laugh", re: /(笑|乐死|乐了|逗乐|绷不住|好活|绝了)/ },
    { id: "shocked", re: /(真敢|没想到|活久见|不是吧|离谱)/ },
    { id: "confused", re: /(没看懂|什么逻辑|搞不懂|你确定|问号|什么意思|啊这|问住)/ },
    { id: "happy", re: /(不错|还行|挺好|有点意思|有眼光|满意|舒服|听懂了|往下说|算你)/ },
    { id: "excited", re: /(带劲|来劲|想看|等不及|好家伙|有戏)/ },
    { id: "sad", re: /(心疼|可怜|难受|心酸|破防|低落)/ },
    { id: "angry", re: /(气死|生气|火大|气人|找骂|别逼|过分)/ },
    { id: "greet", re: /(我在|来了|陪你|别硬撑|先歇|慢点|没事|怎么了|谁惹你|别一个人憋着|先别刷|视频先放一边|视频先停|视频又不会跑)/ }
  ];

  function resultFor(id, score, matched) {
    var e = EMOTIONS[id];
    return { id: id, label: e.label, score: score || 0.8, matched: matched || [] };
  }

  function get(input) {
    if (!input) return null;
    var key = String(input).trim().toLowerCase();
    if (EMOTIONS[key]) return EMOTIONS[key];
    for (var i = 0; i < ORDER.length; i++) {
      var e = EMOTIONS[ORDER[i]];
      for (var j = 0; j < e.aliases.length; j++) {
        if (String(e.aliases[j]).toLowerCase() === key) return e;
      }
    }
    return null;
  }

  function detect(text) {
    var t = String(text == null ? "" : text).toLowerCase();
    if (!t.trim()) return null;
    var best = null;
    ORDER.forEach(function (id) {
      var e = EMOTIONS[id];
      var score = 0;
      var matched = [];
      e.keywords.forEach(function (k) {
        var kk = String(k).toLowerCase();
        var from = 0;
        var count = 0;
        var idx;
        while ((idx = t.indexOf(kk, from)) !== -1) {
          count += 1;
          from = idx + kk.length;
        }
        if (count) {
          score += kk.length * count + (kk.length >= 3 ? 0.5 : 0);
          matched.push(k);
        }
      });
      if (score > 0 && (!best || score > best.score)) {
        best = { id: id, label: e.label, score: score, matched: matched };
      }
    });
    if (best) return best;

    for (var i = 0; i < TONE_RULES.length; i += 1) {
      var rule = TONE_RULES[i];
      if (rule.re.test(t)) return resultFor(rule.id, 0.8, [String(rule.re)]);
    }

    if (/^[?？]+$/.test(t)) return resultFor("confused", 0.6, ["?"]);
    if (/[?？]/.test(t)) return resultFor("confused", 0.45, ["?"]);
    return null;
  }

  function fromMood(mood) {
    if (!mood) return null;
    var direct = get(mood);
    if (direct) return direct;
    var key = String(mood).trim();
    return get(MOOD_MAP[key] || "") || null;
  }

  function iconPath(id, size, base) {
    var e = get(id) || EMOTIONS[DEFAULT];
    var px = size || 128;
    var path = e.id + "-" + px + ".png";
    if (base) return base.replace(/\/+$/, "") + "/" + path;
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
        return chrome.runtime.getURL(ICON_DIR + "/" + path);
      }
    } catch (_error) { /* not in extension context */ }
    return ICON_DIR + "/" + path;
  }

  function preload(base) {
    return ORDER.map(function (id) { return iconPath(id, 128, base); });
  }

  return {
    EMOTIONS: EMOTIONS,
    ORDER: ORDER,
    DEFAULT: DEFAULT,
    MOOD_MAP: MOOD_MAP,
    get: get,
    detect: detect,
    fromMood: fromMood,
    iconPath: iconPath,
    preload: preload,
    version: 1
  };
});
