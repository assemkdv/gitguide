// Incremental Server-Sent Events parser (the subset of the spec GitGuide's API uses):
// events are separated by a blank line; `data:` lines in one event are joined with "\n";
// lines starting with ":" are comments (heartbeats); \r\n, \r and \n all end a line; and
// input may be split anywhere — mid-line, mid-event, even between "\r" and "\n".

export interface SseParser {
  /** Feeds decoded text; returns the data payloads of events completed by it. */
  push(text: string): string[];
  /** Ends the stream; returns a final event if the server omitted the trailing blank line. */
  end(): string[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let pendingCR = false;

  const takeEvent = (out: string[]) => {
    if (dataLines.length > 0) out.push(dataLines.join('\n'));
    dataLines = [];
  };

  const processLine = (line: string, out: string[]) => {
    if (line === '') {
      takeEvent(out);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    // `event`, `id`, `retry` are not used by this API.
  };

  return {
    push(text: string): string[] {
      const out: string[] = [];
      let input = text;
      // A "\r" at the end of the previous chunk already ended its line; skip a matching "\n".
      if (pendingCR && input.startsWith('\n')) input = input.slice(1);
      pendingCR = false;
      buffer += input;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        processLine(buffer.slice(start, i), out);
        if (ch === '\r') {
          if (i + 1 < buffer.length) {
            if (buffer[i + 1] === '\n') i++;
          } else {
            pendingCR = true;
          }
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
    end(): string[] {
      const out: string[] = [];
      if (buffer !== '') processLine(buffer, out);
      buffer = '';
      takeEvent(out);
      return out;
    },
  };
}
