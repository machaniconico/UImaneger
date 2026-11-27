import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { apiKey, editedHeading, model, originalHeading, relFile, test } from "./fixtures";

const instruction = `見出しを「${editedHeading}」に変更して`;

test("opens, selects, proposes, applies and undoes an edit with live HMR", async ({ app, page, context }) => {
  const before = page.frameLocator('iframe[title="before"]');
  const live = page.frameLocator('iframe[title="after"]');
  const log = page.getByRole("log");
  const input = page.getByRole("textbox", { name: "編集指示" });
  const apply = page.getByRole("button", { name: "承認して適用" });
  const undo = page.getByRole("button", { name: "↩ undo (1)" });

  await test.step("Open the temporary sample and render both previews", async () => {
    await page.goto(app.url);
    await expect(page.getByText("API key OK", { exact: true }).first()).toBeVisible();
    await expect(input).toBeDisabled();
    await page.getByRole("textbox", { name: "ローカルパスまたはGitリポジトリURL" }).fill(app.sample);
    await page.getByRole("button", { name: "開く", exact: true }).click();
    await expect(page.getByText("sample-app · Vite", { exact: true })).toBeVisible();
    await expect(before.getByRole("heading", { name: originalHeading, exact: true })).toBeVisible();
    await expect(live.getByRole("heading", { name: originalHeading, exact: true })).toBeVisible();
  });

  await test.step("Select the heading in the before iframe", async () => {
    await page.getByRole("button", { name: "要素を選択" }).click();
    await expect(page.getByRole("button", { name: "選択中…" })).toHaveAttribute("aria-pressed", "true");
    await expect(before.locator("html")).toHaveCSS("cursor", "crosshair");
    await before.getByRole("heading", { name: originalHeading, exact: true }).click();
    await expect(page.getByText("<h1>", { exact: true })).toBeVisible();
    await expect(page.getByText(`“${originalHeading}”`, { exact: true })).toBeVisible();
    await expect(input).toBeEnabled();
  });

  await test.step("Generate and display the diff without writing the file", async () => {
    await input.fill(instruction);
    await page.getByRole("button", { name: /^差分を生成/ }).click();
    await expect(log.getByText("差分の準備ができました。承認または却下してください。")).toBeVisible();
    await expect(page.getByText(relFile, { exact: true })).toBeVisible();
    await expect(page.locator("pre").getByText(/^-.+サンプルアプリ<\/h1>$/)).toBeVisible();
    await expect(page.locator("pre").getByText(/^\+.+ブラウザE2Eで編集済み<\/h1>$/)).toBeVisible();
    await expect(apply).toBeEnabled();
    expect(await readFile(app.file, "utf8")).toBe(app.original);
    await expect(live.getByRole("heading", { name: originalHeading, exact: true })).toBeVisible();
  });

  // Vite は HMR で更新するため、適用・undo でも iframe は作り直さない。別タブ(observer)でも
  // 見出しの更新とカウンタの保持を確認し、Fast Refresh で反映されていることを示す。
  const observer = await context.newPage();
  const observerIframe = observer.locator('iframe[title="after"]');
  const hmr = observerIframe.contentFrame();
  const connectedHmrHosts = new Set<string>();
  observer.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (payload === '{"type":"connected"}') {
        connectedHmrHosts.add(new URL(socket.url()).host);
      }
    });
  });
  await test.step("Prime React state in a second live preview", async () => {
    await observer.goto(app.url);
    await expect(hmr.getByRole("heading", { name: originalHeading, exact: true })).toBeVisible();
    const previewHost = await observerIframe.evaluate((iframe: HTMLIFrameElement) =>
      new URL(iframe.src).host
    );
    await expect.poll(() => connectedHmrHosts.has(previewHost), {
      message: "Vite HMR is connected through the live preview proxy",
    }).toBe(true);
    await hmr.getByRole("button", { name: "カウント: 0", exact: true }).click();
    await expect(hmr.getByRole("button", { name: "カウント: 1", exact: true })).toBeVisible();
  });

  await test.step("Apply the diff and observe HMR in the live preview", async () => {
    await apply.click();
    await expect(log.getByText(`✓ ${relFile} に適用しました`, { exact: true })).toBeVisible();
    await expect(apply).toBeHidden();
    await expect(undo).toBeEnabled();
    expect(await readFile(app.file, "utf8")).toBe(app.edited);
    await expect(live.getByRole("heading", { name: editedHeading, exact: true })).toBeVisible();
    await expect(hmr.getByRole("heading", { name: editedHeading, exact: true })).toBeVisible();
    await expect(hmr.getByRole("button", { name: "カウント: 1", exact: true })).toBeVisible();
    await expect(before.getByRole("heading", { name: originalHeading, exact: true })).toBeVisible();
  });

  await test.step("Undo the edit and observe HMR restoring the original heading", async () => {
    await undo.click();
    await expect(log.getByText(`↩ ${relFile} を元に戻しました`, { exact: true })).toBeVisible();
    await expect(undo).toBeHidden();
    expect(await readFile(app.file, "utf8")).toBe(app.original);
    await expect(live.getByRole("heading", { name: originalHeading, exact: true })).toBeVisible();
    await expect(hmr.getByRole("heading", { name: originalHeading, exact: true })).toBeVisible();
    await expect(hmr.getByRole("button", { name: "カウント: 1", exact: true })).toBeVisible();
  });

  await test.step("Verify the one Anthropic Messages request", async () => {
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/messages",
      apiKey,
      body: {
        model,
        max_tokens: 64_000,
        stream: true,
        messages: [{ role: "user", content: expect.any(String) }],
      },
    });
    const prompt = app.requests[0].body.messages?.[0].content;
    expect(prompt).toContain(`# 対象ファイル: ${relFile}`);
    expect(prompt).toContain("- tag: h1");
    expect(prompt).toContain(`- text: ${originalHeading}`);
    expect(prompt).toContain(`# ユーザーの指示\n${instruction}`);
    expect(prompt).toContain(app.original);
  });
});
