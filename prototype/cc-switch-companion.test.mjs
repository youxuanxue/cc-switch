import assert from "node:assert/strict";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

async function runPrototypeAssertions() {
  const prototypePath = resolve(
    process.cwd(),
    "prototype/cc-switch-companion.html",
  );

  const runtimeErrors = [];
  const dom = await JSDOM.fromFile(prototypePath, {
    resources: "usable",
    runScripts: "dangerously",
    beforeParse(window) {
      window.scrollTo = () => {};
      window.addEventListener("error", (event) => {
        runtimeErrors.push(event.error?.message ?? event.message);
      });
    },
  });

  await new Promise((resolve) => dom.window.addEventListener("load", resolve));

  const { document } = dom.window;
  const click = (selector) => {
    const target = document.querySelector(selector);
    assert.ok(target, `Missing interactive target: ${selector}`);
    target.click();
  };

  assert.ok(
    document.querySelector('[data-view="tools"]')?.classList.contains("active"),
    "Tools must be the default view",
  );
  assert.equal(
    document.querySelector(".brand-name")?.textContent,
    "Tandem",
    "The cockpit must use the Tandem product name",
  );

  click('[data-view-target="companion"]');
  assert.ok(
    document
      .querySelector('[data-view="companion"]')
      ?.classList.contains("active"),
    "Companion navigation must activate the companion view",
  );

  click('[data-view-target="config"]');
  assert.ok(
    document
      .querySelector('[data-view="config"]')
      ?.classList.contains("active"),
    "Native cc-switch configuration must remain a first-level view",
  );
  assert.equal(
    document.querySelectorAll("[data-config-app]").length,
    8,
    "All native managed platforms must remain visible",
  );
  const managedPlatforms = [
    ...document.querySelectorAll("[data-config-app]"),
  ].map((button) => button.dataset.configApp);
  assert.deepEqual(managedPlatforms, [
    "Claude Code",
    "Claude Desktop",
    "Codex",
    "Gemini CLI",
    "Grok Build",
    "OpenCode",
    "OpenClaw",
    "Hermes",
  ]);
  assert.equal(
    document
      .querySelector('[data-upstream-surface="NativeConfigSurface"]')
      ?.getAttribute("data-upstream-surface"),
    "NativeConfigSurface",
    "The cockpit must mount the upstream-owned native configuration surface",
  );
  assert.equal(
    document.querySelectorAll("[data-provider-row]").length,
    4,
    "The native surface must retain a dense ProviderList instead of capability cards",
  );
  const currentProviderActions = [
    ...document.querySelectorAll(
      '[data-provider-row="TokenKey-kiro"] [data-provider-action]',
    ),
  ].map((button) => button.dataset.providerAction);
  assert.deepEqual(currentProviderActions, [
    "edit",
    "duplicate",
    "health",
    "usage",
    "terminal",
    "delete",
  ]);
  const nativeCapabilityEntries = [
    ...document.querySelectorAll("[data-native-capability]"),
  ].map((button) => button.dataset.nativeCapability);
  assert.deepEqual(nativeCapabilityEntries, [
    "搜索供应商",
    "本地代理与故障转移",
    "Skills",
    "Prompts",
    "原生会话",
    "MCP",
    "用量与成本",
    "同步与备份",
    "导入当前配置",
  ]);
  assert.equal(
    document.querySelectorAll('[data-provider-action="switch"]').length,
    3,
    "Every non-current Provider row must retain the native switch action",
  );
  click('[data-config-app="Hermes"]');
  assert.equal(
    document.querySelector("#config-provider-title")?.textContent,
    "Hermes 供应商",
  );
  assert.equal(
    document.querySelector("#active-provider-route")?.textContent,
    "TokenKey · Provider Profile",
  );
  assert.equal(
    document.querySelector("#fallback-provider-name")?.textContent,
    "Nous Research",
  );
  assert.equal(
    document.querySelector("#fallback-provider-url")?.textContent,
    "https://nousresearch.com",
  );
  click('[data-native-capability="MCP"]');
  assert.equal(
    document.querySelector("#toast-copy")?.textContent,
    "已打开 MCP",
  );

  click("#open-device-setup");
  assert.ok(
    document.querySelector("#setup-backdrop")?.classList.contains("open"),
    "Cold start must open the secure TokenKey bootstrap",
  );
  assert.equal(
    document.querySelectorAll("[data-bootstrap-platform]").length,
    8,
  );
  assert.doesNotMatch(
    document.documentElement.outerHTML,
    /(?:sk|tk)_[A-Za-z0-9_-]{8,}/,
    "The prototype must never contain a plaintext API key",
  );
  const bootstrapPlatforms = [
    ...document.querySelectorAll("[data-bootstrap-platform]"),
  ];
  bootstrapPlatforms.forEach((checkbox) => {
    checkbox.checked = false;
    checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.equal(
    document.querySelector("#apply-device-setup")?.disabled,
    true,
    "Applying a bootstrap without a target platform must be blocked",
  );
  assert.ok(document.querySelector("#setup-error")?.classList.contains("show"));
  bootstrapPlatforms.forEach((checkbox) => {
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  click("#apply-device-setup");
  assert.equal(
    document.querySelector("#bootstrap-meta")?.textContent,
    "8 个平台验证通过 · 原配置已备份",
  );
  assert.equal(
    document.querySelector("#toast-copy")?.textContent,
    "TokenKey 已安全配置到 8 个平台",
  );

  click('[data-view-target="tools"]');
  click("#home-arrange");
  assert.ok(
    document.querySelector("#command-backdrop")?.classList.contains("open"),
    "Arrange must open the tool launcher",
  );
  assert.ok(
    document.querySelector("#new-task-flow")?.classList.contains("active"),
    "The launcher must open in new-task mode",
  );
  assert.equal(
    document.querySelector("#planned-worktree")?.textContent,
    "../cc-switch-wt-handoff-ux",
    "A new task must preview its isolated worktree",
  );
  assert.equal(
    document.querySelector(".workspace-technical")?.open,
    false,
    "Git and worktree details must be collapsed by default",
  );
  assert.equal(
    document.querySelector(".workspace-outcome strong")?.textContent,
    "从项目最新安全版本开始",
    "The default plan must explain the user outcome instead of Git mechanics",
  );
  assert.equal(
    document.querySelector("#start-button-label")?.textContent,
    "创建独立工作现场并在 Claude Code 开始",
  );

  const commandInput = document.querySelector("#dialog-command");
  assert.ok(commandInput instanceof dom.window.HTMLInputElement);
  commandInput.value = "";
  click("#start-selected-tool");
  assert.ok(
    document.querySelector("#command-error")?.classList.contains("show"),
    "An empty task must be rejected",
  );

  commandInput.value = "验证接力包的数据契约";
  click('[data-tool-option="Codex"]');
  click("#start-selected-tool");
  assert.equal(
    document.querySelector("#active-run-task")?.textContent,
    "验证接力包的数据契约",
  );
  assert.equal(
    document.querySelector("#active-run-tool")?.textContent,
    "Codex · 已装载我的搭子",
  );
  assert.equal(
    document.querySelector("#active-run-workspace")?.textContent,
    "独立工作现场",
  );
  assert.equal(
    document.querySelector("#toast-copy")?.textContent,
    "独立工作现场已创建，Codex 正在启动",
  );

  click('[data-home-mode="resume"]');
  assert.ok(
    document.querySelector("#home-resume-panel")?.classList.contains("active"),
    "Continue-task mode must expose an existing worktree",
  );
  click("#home-resume");
  assert.ok(
    document.querySelector("#resume-task-flow")?.classList.contains("active"),
    "Continue task must use a dedicated resume flow",
  );
  click('[data-resume-option="routing-recovery"]');
  assert.equal(
    document.querySelector("#dialog-footer-note")?.textContent,
    "复用已有工作现场 · 不创建新的工作现场",
  );
  assert.equal(
    document.querySelector("#start-button-label")?.textContent,
    "回到 Claude Code 继续",
  );
  click("#start-selected-tool");
  assert.equal(
    document.querySelector("#active-run-task")?.textContent,
    "模型路由故障恢复",
  );
  assert.equal(
    document.querySelector("#active-run-tool")?.textContent,
    "Claude Code · 原生会话已恢复",
  );
  assert.equal(
    document.querySelector("#active-run-workspace")?.textContent,
    "独立工作现场",
  );
  assert.equal(
    document.querySelector("#return-to-tool-label")?.textContent,
    "回到 Claude Code",
    "The cockpit must return users to the native tool instead of owning execution controls",
  );
  assert.equal(
    document.querySelector("#current-tool-state")?.textContent,
    "Claude Code 中",
  );
  assert.equal(
    document.querySelector("#toast-copy")?.textContent,
    "已回到 Claude Code 的原工作现场",
  );

  click('[data-launch-tool="Kiro"]');
  assert.ok(
    document.querySelector("#new-task-flow")?.classList.contains("active"),
    "Launching a tool card must always create a new task",
  );
  click("#start-selected-tool");
  assert.equal(
    document.querySelector("#active-run-initial")?.textContent,
    "K",
    "A launcher-only tool must retain a visible fallback mark",
  );

  click("[data-open-handoff]");
  click('[data-destination="Grok Build"]');
  click("#start-handoff");
  assert.equal(
    document.querySelector("#toast-copy")?.textContent,
    "Grok Build 已收到当前工作现场的接力包",
  );

  click("#learn-keep");
  assert.ok(
    document.querySelector("#memory-proposal")?.classList.contains("resolved"),
    "A confirmed learning must move to the resolved state",
  );
  assert.equal(runtimeErrors.length, 0, runtimeErrors.join(" | "));

  console.log(
    JSON.stringify(
      {
        defaultView: "tools",
        navigation: "passed",
        nativeConfiguration: "passed",
        tokenKeyBootstrap: "passed",
        emptyTaskGuard: "passed",
        isolatedTaskLaunch: "passed",
        nativeSessionResume: "passed",
        launcherFallback: "passed",
        handoff: "passed",
        learningConfirmation: "passed",
      },
      null,
      2,
    ),
  );

  dom.window.close();
}

if (process.env.VITEST) {
  const { test } = await import("vitest");
  test("Tandem companion prototype interactions", runPrototypeAssertions);
} else {
  await runPrototypeAssertions();
}
