import { expect, test } from "@playwright/test";
import { getRecordedInvokes, installTauriIpcHarness } from "./tauriIpcHarness";

test("sets Pi defaults and changes the model on the default provider through the real UI", async ({
  page,
}) => {
  const piProviders = Object.fromEntries(
    ["alpha", "beta"].map((id) => [
      id,
      {
        id,
        name: `${id} Pi`,
        settingsConfig: {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          models: [{ id: `${id}-one` }, { id: `${id}-two` }],
        },
      },
    ]),
  );
  await installTauriIpcHarness(page, {
    view: "providers",
    lastApp: "pi",
    piProviders,
    piCurrentState: {
      enabledProviderIds: ["alpha", "beta"],
      defaultProviderId: "alpha",
      defaultModelId: "alpha-one",
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "我知道了", exact: true }).click();
  const alpha = page
    .locator("div.group.relative.rounded-panel")
    .filter({ has: page.getByText("alpha Pi", { exact: true }) });
  const beta = page
    .locator("div.group.relative.rounded-panel")
    .filter({ has: page.getByText("beta Pi", { exact: true }) });
  await expect(alpha.getByText("alpha-one", { exact: false })).toBeVisible();
  await beta.getByRole("button", { name: "设为默认", exact: true }).click();
  await page.getByRole("menuitem", { name: "beta-one", exact: true }).click();
  await expect(beta.getByText("beta-one", { exact: false })).toBeVisible();
  await expect(alpha.getByText("alpha-one", { exact: false })).toHaveCount(0);
  await beta.getByRole("button", { name: "设为默认", exact: true }).click();
  await page.getByRole("menuitem", { name: "beta-two", exact: true }).click();
  await expect(beta.getByText("beta-two", { exact: false })).toBeVisible();
  const writes = (await getRecordedInvokes(page)).filter(
    (call) => call.command === "set_pi_default_provider",
  );
  expect(writes.map((call) => call.payload)).toEqual([
    { id: "beta", model: "beta-one" },
    { id: "beta", model: "beta-two" },
  ]);
});
