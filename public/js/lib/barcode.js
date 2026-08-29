/* Dependency-free Code 128 barcode -> SVG string. Code 128 B (all printable ASCII),
   with a Code 128 C run for 4+ consecutive digits so numeric SKUs stay compact.
   Returns an <svg> string sized in user units (1 unit = 1 narrow module).

   Reads back cleanly with public/mobile/lib/scanner.js (BarcodeDetector / ZXing). */
(function () {
  // The 107 Code 128 element-width patterns (index 0..106). Each is bar,space,bar,…
  // starting and ending with a bar. Value 106 (stop) is the 7-element pattern.
  var PATTERNS = (
    '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
    '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
    '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
    '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
    '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
    '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
    '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
    '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
    '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
    '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
    '114131 311141 411131 211412 211214 211232 2331112'
  ).trim().split(/\s+/);

  var START_B = 104, START_C = 105, STOP = 106, CODE_B = 100, CODE_C = 99;

  function digitsRun(s, i) {
    var n = 0;
    while (i + n < s.length && s[i + n] >= '0' && s[i + n] <= '9') n++;
    return n;
  }

  /** Code-value sequence (without start/checksum/stop) for a string. */
  function encodeValues(text) {
    var vals = [];
    var mode = 'B';
    var i = 0;
    // Opening mode: C if the whole thing is an even number of digits >= 4, or a long run.
    var lead = digitsRun(text, 0);
    if (lead >= 4 && (lead === text.length ? lead % 2 === 0 : lead >= 4)) {
      vals.push(START_C); mode = 'C';
    } else {
      vals.push(START_B); mode = 'B';
    }
    while (i < text.length) {
      if (mode === 'C') {
        var run = digitsRun(text, i);
        if (run >= 2 && !(run % 2 === 1 && run < 4)) {
          // consume pairs while we have an even count ahead (or 2+ with more to come)
          if (run % 2 === 1) run -= 1;
          for (var k = 0; k < run; k += 2) vals.push(parseInt(text.substr(i + k, 2), 10));
          i += run;
          if (i < text.length) { vals.push(CODE_B); mode = 'B'; }
        } else {
          vals.push(CODE_B); mode = 'B';
        }
      } else {
        var r = digitsRun(text, i);
        var atEnd = (i + r === text.length);
        if (r >= 4 && (atEnd ? r % 2 === 0 : r >= 6)) {
          vals.push(CODE_C); mode = 'C';
        } else {
          var c = text.charCodeAt(i);
          if (c < 32 || c > 126) c = 63; // '?' for anything outside Code 128 B
          vals.push(c - 32);
          i += 1;
        }
      }
    }
    return vals;
  }

  /**
   * code128svg(text, opts) -> string
   * opts: { height=60, moduleWidth=2, margin=10, showText=true, textHeight=16 }
   */
  function code128svg(text, opts) {
    text = String(text == null ? '' : text);
    opts = opts || {};
    var h = opts.height || 60;
    var mw = opts.moduleWidth || 2;
    var margin = opts.margin != null ? opts.margin : 10;
    var showText = opts.showText !== false;
    var textH = showText ? (opts.textHeight || 16) : 0;

    if (!text) return '';
    var vals = encodeValues(text);
    var sum = vals[0];
    for (var i = 1; i < vals.length; i++) sum += vals[i] * i;
    vals.push(sum % 103); // checksum
    vals.push(STOP);

    // Build the bar/space run-lengths in modules.
    var x = margin;
    var rects = [];
    for (var v = 0; v < vals.length; v++) {
      var pat = PATTERNS[vals[v]];
      var bar = true;
      for (var p = 0; p < pat.length; p++) {
        var w = parseInt(pat[p], 10) * mw;
        if (bar) rects.push('<rect x="' + x.toFixed(2) + '" y="0" width="' + w.toFixed(2) + '" height="' + h + '"/>');
        x += w;
        bar = !bar;
      }
    }
    var totalW = x + margin;
    var label = showText
      ? '<text x="' + (totalW / 2).toFixed(2) + '" y="' + (h + textH - 3) +
        '" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="' +
        (textH - 3) + '">' + String(text).replace(/[<&>]/g, function (m) {
          return m === '<' ? '&lt;' : m === '>' ? '&gt;' : '&amp;';
        }) + '</text>'
      : '';

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + totalW.toFixed(2) +
      '" height="' + (h + textH) + '" viewBox="0 0 ' + totalW.toFixed(2) + ' ' + (h + textH) +
      '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="#fff"/>' +
      '<g fill="#000">' + rects.join('') + '</g>' + label + '</svg>';
  }

  window.Barcode = { code128svg: code128svg };
})();
