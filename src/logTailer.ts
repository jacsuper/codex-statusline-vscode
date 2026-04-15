import * as fs from 'node:fs/promises';

const historyReadChunkBytes = 1024 * 1024; // Read 1MB chunks to handle "fat" JSON objects in history

export interface TailedLogLine {
  text: string;
  lineNumber: number;
}

export class LogTailer {
  private activePath: string | undefined;
  private offset = 0;
  private pendingLine = '';
  private nextLineNumber = 1;

  async switchTo(filePath: string): Promise<void> {
    if (filePath === this.activePath) {
      return;
    }

    const stat = await fs.stat(filePath);
    this.activePath = filePath;
    this.offset = stat.size;
    this.pendingLine = '';
    this.nextLineNumber = (await countCompleteLines(filePath)) + 1;
  }

  reset(): void {
    this.activePath = undefined;
    this.offset = 0;
    this.pendingLine = '';
    this.nextLineNumber = 1;
  }

  async readRecentCompleteLines(filePath: string, maxLines: number): Promise<TailedLogLine[]> {
    if (maxLines <= 0) {
      await this.switchTo(filePath);
      return [];
    }

    const stat = await fs.stat(filePath);
    this.activePath = filePath;
    this.offset = stat.size;
    this.pendingLine = '';
    this.nextLineNumber = (await countCompleteLines(filePath)) + 1;

    if (stat.size === 0) {
      return [];
    }

    const handle = await fs.open(filePath, 'r');

    try {
      const chunks: Buffer[] = [];
      let position = stat.size;
      let newlineCount = 0;

      while (position > 0 && newlineCount < maxLines + 1) {
        const length = Math.min(historyReadChunkBytes, position);
        position -= length;

        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, position);
        const chunk = buffer.subarray(0, result.bytesRead);
        chunks.unshift(chunk);
        newlineCount += countNewlines(chunk);

        if (result.bytesRead === 0) {
          break;
        }
      }

      const historyBuffer = Buffer.concat(chunks);
      const text = historyBuffer.toString('utf8');
      const startLineNumber = this.nextLineNumber - countNewlines(historyBuffer);
      const recent = extractRecentCompleteLines(text, maxLines, startLineNumber);
      
      this.pendingLine = recent.pendingLine;
      return recent.lines;
    } finally {
      await handle.close();
    }
  }

  async readAppendedLines(filePath: string): Promise<TailedLogLine[]> {
    await this.switchTo(filePath);

    const stat = await fs.stat(filePath);

    if (stat.size < this.offset) {
      this.offset = 0;
      this.pendingLine = '';
      this.nextLineNumber = 1;
    }

    if (stat.size === this.offset) {
      return [];
    }

    const length = stat.size - this.offset;
    const handle = await fs.open(filePath, 'r');

    try {
      const buffer = Buffer.alloc(length);
      let totalBytesRead = 0;

      while (totalBytesRead < length) {
        const result = await handle.read(buffer, totalBytesRead, length - totalBytesRead, this.offset + totalBytesRead);

        if (result.bytesRead === 0) {
          break;
        }

        totalBytesRead += result.bytesRead;
      }

      this.offset += totalBytesRead;
      return this.extractCompleteLines(buffer.subarray(0, totalBytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
  }

  private extractCompleteLines(chunk: string): TailedLogLine[] {
    const text = this.pendingLine + chunk;
    const parts = text.split(/\r?\n/);

    this.pendingLine = parts.pop() ?? '';
    const lines: TailedLogLine[] = [];

    for (const line of parts) {
      const lineNumber = this.nextLineNumber;
      this.nextLineNumber += 1;

      if (line.length > 0) {
        lines.push({ text: line, lineNumber });
      }
    }

    return lines;
  }
}

function countNewlines(chunk: Buffer): number {
  let count = 0;

  for (const byte of chunk) {
    if (byte === 10) {
      count += 1;
    }
  }

  return count;
}

async function countCompleteLines(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, 'r');

  try {
    return await countCompleteLinesBefore(handle, stat.size);
  } finally {
    await handle.close();
  }
}

async function countCompleteLinesBefore(handle: fs.FileHandle, endOffset: number): Promise<number> {
  let count = 0;
  let position = 0;

  while (position < endOffset) {
    const length = Math.min(historyReadChunkBytes, endOffset - position);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, position);

    if (result.bytesRead === 0) {
      break;
    }

    count += countNewlines(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }

  return count;
}

function extractRecentCompleteLines(
  text: string,
  maxLines: number,
  firstLineNumber: number
): { lines: TailedLogLine[]; pendingLine: string } {
  const lines = text.split(/\r?\n/);
  const pendingLine = lines.pop() ?? '';

  return {
    lines: lines
      .map((line, index) => ({ text: line, lineNumber: firstLineNumber + index }))
      .filter((line) => line.text.length > 0)
      .slice(-maxLines),
    pendingLine
  };
}
