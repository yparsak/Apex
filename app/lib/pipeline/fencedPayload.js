// Detecting and removing chat-formatting around file bytes (see ROADMAP.md
// Phase 30).
//
// A model that is asked for "the COMPLETE new contents of that file" and
// answers with a markdown code fence has not misunderstood the request - it
// has answered it the way chat answers are formatted. Nothing upstream is
// wrong about its intent; the framing simply arrives with the content, and
// through Phase 29 nothing stripped it. The fence then becomes line 1 of a
// real file on a real branch, which breaks the file *and* shifts every line
// in it by one, so the next anchored write against it fails its EXPECTED
// check for reasons that have nothing to do with what the model got wrong.
//
// **The hard rule here is that a guess would be worse than the bug.** Stripping
// a wrapper off a payload that was never wrapped corrupts a file that was
// fine. So this module only ever recognizes a payload whose fencing is
// *unambiguous*, and says "I don't know" about everything else - which the
// write path turns into either an untouched write or a refusal turn, never a
// repair it is unsure of.
//
// Three outcomes, and the caller must handle all three:
//
//   { kind: 'clean' }     - line 1 is not a fence at all. Write it verbatim;
//                           this is the overwhelming majority of payloads.
//   { kind: 'wrapped' }   - line 1 is nothing but a fence opener and the last
//                           line is nothing but its matching closer, with no
//                           fence line anywhere between them. `content` is the
//                           payload with those two lines removed. Write that,
//                           and tell the model it happened.
//   { kind: 'ambiguous' } - line 1 is a fence opener but the payload is not
//                           unambiguously wrapped. Refuse the write; `reason`
//                           says why, phrased as a predicate ("opens with a
//                           code fence that is never closed") so each caller
//                           supplies its own subject.
//   { kind: 'document' }  - line 1 is a fence opener and the interior carries
//                           fence lines of its own, i.e. this is plausibly a
//                           markdown document that genuinely begins with a
//                           fenced block. Write it verbatim, untouched.
//
// Note that 'document' is decided by *structure*, not by file extension. A
// `.md` file can legitimately open and close with a fence, and keying the
// exemption off the extension is the version of this that gets reported as a
// regression - it would both miss a fenced `.md` payload the model wrapped and
// mangle a fenced block inside a `.txt` or a docstring. Interior fences are
// the evidence, whatever the file is called.

// A fence *line*: three or more backticks or tildes and nothing else but an
// optional single info token (`python`, `js`, `diff`). Anything with more
// structure than that - prose after the fence, indentation before it - is not
// treated as a fence line at all, because the shapes this module acts on have
// to be the ones nobody can argue about.
const FENCE_LINE = /^(`{3,}|~{3,})[ \t]*([^\s`~]*)[ \t]*$/;

function parseFenceLine(line) {
  const match = line.match(FENCE_LINE);
  if (!match) return null;
  return { char: match[1][0], length: match[1].length, info: match[2] || '' };
}

// classify(text) -> one of the four outcomes above. Pure; `text` is the
// payload exactly as it arrived, after the caller's own trailing-newline
// normalization.
function classify(text) {
  if (text === '') return { kind: 'clean' };

  const all = text.split('\n');
  // Blank lines before the opener are skipped, and are dropped with the
  // wrapper if one is found. A payload that opens with "\n```python" is just
  // as unambiguously wrapped as one that opens with "```python", and a file
  // whose intended first line is blank is not a thing anyone means - whereas
  // refusing to see the fence here would reintroduce exactly the bug this
  // module exists to fix. Nothing *after* the opener is skipped: that is file
  // content, blank or not. (Trailing whitespace is already normalized away by
  // the caller, so the closer is reliably the last line.)
  const lead = all.findIndex((line) => line.trim() !== '');
  if (lead === -1) return { kind: 'clean' };
  const lines = all.slice(lead);
  const opener = parseFenceLine(lines[0]);
  if (!opener) return { kind: 'clean' };

  // An opener alone, with nothing after it, is not a file - it is a reply that
  // stopped. There is no content to unwrap and no content to write.
  if (lines.length < 2) {
    return {
      kind: 'ambiguous',
      reason: 'is a single code-fence line, with no file contents after it',
    };
  }

  const interior = lines.slice(1, -1);
  const interiorHasFence = interior.some((line) => parseFenceLine(line) !== null);
  const closer = parseFenceLine(lines[lines.length - 1]);

  // The one case that is acted on. The closer must use the same character, be
  // at least as long as the opener (CommonMark's own rule), and carry no info
  // token - and nothing between the two may look like a fence, or the payload
  // is a document containing fences rather than a file wrapped in one.
  const closes = closer && closer.char === opener.char && closer.length >= opener.length && closer.info === '';
  if (closes && !interiorHasFence) {
    return { kind: 'wrapped', content: interior.join('\n'), info: opener.info };
  }

  if (interiorHasFence) return { kind: 'document' };

  return {
    kind: 'ambiguous',
    reason: closer
      ? 'opens with a code fence and ends with one that does not match it'
      : 'opens with a code fence that is never closed',
  };
}

module.exports = { classify, parseFenceLine };
