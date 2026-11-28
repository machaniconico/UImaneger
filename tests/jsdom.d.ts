// jsdom は vitest の jsdom 環境用に入っているが @types/jsdom は依存に無いため、
// テストで直接使う JSDOM の最小限の型だけ宣言する。
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis;
  }
}
