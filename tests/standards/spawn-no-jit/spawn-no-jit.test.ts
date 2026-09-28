import { describe, expect, it } from "bun:test";

describe("Тест, который запускает bun, не падает от крэша macOS 27 при старте процесса: на macOS дочерний bun — без JIT", () => {
  /**
   * Прогон ставит `BUN_JSC_useJIT=0` в своё окружение до первого теста, дочерние процессы его наследуют. На других
   * системах бага нет, и JIT остаётся.
   */
  it("на macOS окружение прогона выключает JIT дочерним процессам, на других системах — не трогает", () => {
    expect(process.env.BUN_JSC_useJIT).toBe(process.platform === "darwin" ? "0" : undefined);
  });
});
