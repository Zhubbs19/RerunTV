// This must run in <head>, before CSS and the first paint. The native Android
// TV client identifies its WebView with a stable UA suffix. TV WebViews
// disagree wildly about whether a 4K panel is 960, 1920, or 3840 CSS pixels
// wide; device-width therefore makes the same guide microscopic on one OEM
// and oversized on another. Render the TV client against one 1920-wide
// logical canvas and let WebView composite it at the panel's native
// resolution. Desktop browsers and Electron keep the responsive viewport.
if (/RerunTV-AndroidTV/i.test(navigator.userAgent)) {
  document.getElementById('reruntv-viewport').setAttribute(
    'content',
    'width=1920, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
  );
  document.documentElement.dataset.tvClient = 'android';
}

// A first guess at the usage mode, so a TV never paints desktop hints for a
// frame. usage-mode.js (resolveUsageMode) is the real resolver and re-stamps
// this as soon as the app starts; keep the precedence here the same: this
// device's choice, then ?mode=, then a TV user agent.
(function stampUsageModeEarly() {
  var mode = null;
  try {
    var stored = window.localStorage.getItem('reruntv.usageMode');
    if (stored === 'tv' || stored === 'desktop') mode = stored;
  } catch (e) { /* storage unavailable */ }
  if (!mode) {
    var flag = /[?&]mode=(tv|desktop)\b/i.exec(location.search);
    if (flag) mode = flag[1].toLowerCase();
  }
  if (!mode && /RerunTV-AndroidTV|Tizen|Web0S|webOS/i.test(navigator.userAgent)) mode = 'tv';
  document.documentElement.dataset.mode = mode || 'desktop';
}());
