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
