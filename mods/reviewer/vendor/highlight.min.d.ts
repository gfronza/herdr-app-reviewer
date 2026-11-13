// tsc reads this instead of the minified source, which does not type-check. Only what syntax.js uses.
export type TokenNode = { scope?: string; children: Array<string | TokenNode> };

export type HighlightResult = {
  _top: object;
  _emitter: { rootNode: TokenNode };
  errorRaised?: unknown;
};

declare const hljs: {
  getLanguage(name: string): object | undefined;
  listLanguages(): string[];
  highlight(code: string, options: { language: string; ignoreIllegals: boolean }): HighlightResult;
};

export default hljs;
