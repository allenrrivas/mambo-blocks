/*
 * code-editor.js — syntax-highlighted Python editor.
 *
 * A transparent <textarea> sits on top of a highlighted <pre>, both laid out
 * identically, so the browser's own text editing is untouched: selection,
 * autocorrect suppression, the iPad virtual keyboard and the caret all behave
 * exactly as they do in a plain textarea. Swapping in a JS editor component
 * would put all of that behaviour on us, on the device we have tested least.
 *
 * Alignment holds because neither layer wraps (white-space: pre) and both use
 * the same font, size, line-height and padding. Horizontal scroll is shared.
 */

const LANG = 'python';

export function createCodeEditor(root, { value = '', onChange = () => {} } = {}) {
  root.classList.add('code-editor');
  root.innerHTML = `
    <div class="ce-gutter" aria-hidden="true"></div>
    <div class="ce-stack">
      <pre class="ce-highlight" aria-hidden="true"><code></code></pre>
      <textarea class="ce-input" spellcheck="false" autocapitalize="off"
                autocomplete="off" autocorrect="off" wrap="off"></textarea>
    </div>`;

  const gutter = root.querySelector('.ce-gutter');
  const codeEl = root.querySelector('.ce-highlight code');
  const preEl = root.querySelector('.ce-highlight');
  const input = root.querySelector('.ce-input');

  function paint() {
    const text = input.value;

    // Highlight a trailing newline too, or the final line has no box behind
    // it and the last row of the file drifts out of alignment.
    const source = `${text}\n`;
    if (window.hljs) {
      codeEl.innerHTML = window.hljs.highlight(source, { language: LANG }).value;
    } else {
      codeEl.textContent = source;
    }

    const count = text.split('\n').length;
    let nums = '';
    for (let i = 1; i <= count; i += 1) nums += `${i}\n`;
    gutter.textContent = nums;

    syncScroll();
  }

  function syncScroll() {
    preEl.scrollTop = input.scrollTop;
    preEl.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
  }

  input.addEventListener('input', () => {
    paint();
    onChange(input.value);
  });
  input.addEventListener('scroll', syncScroll);

  // Tab indents; it should not jump to the next control in a code editor.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = input;
    input.value = `${input.value.slice(0, a)}    ${input.value.slice(b)}`;
    input.selectionStart = input.selectionEnd = a + 4;
    paint();
    onChange(input.value);
  });

  input.value = value;
  paint();

  return {
    get value() { return input.value; },
    set value(v) { input.value = v; paint(); },
    focus() { input.focus(); },
    /** Select one line, for pointing at a syntax error. */
    selectLine(lineNo) {
      if (!lineNo) return;
      const lines = input.value.split('\n');
      const start = lines.slice(0, lineNo - 1).reduce((n, l) => n + l.length + 1, 0);
      input.focus();
      input.setSelectionRange(start, start + (lines[lineNo - 1] || '').length);
    },
  };
}

/** Highlight a read-only block of Python, for the teacher's review pane. */
export function highlightBlock(el, code) {
  el.textContent = code;
  if (window.hljs) {
    el.innerHTML = window.hljs.highlight(code, { language: LANG }).value;
  }
}
