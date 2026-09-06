import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, PropsWithChildren } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiFormFields } from "@/components/providers/forms/GeminiFormFields";
import { Form } from "@/components/ui/form";

const modelFetchApiMock = vi.hoisted(() => ({
  fetchModelsForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: modelFetchApiMock.fetchModelsForConfig,
  showFetchModelsError: modelFetchApiMock.showFetchModelsError,
}));

type GeminiFormFieldsProps = ComponentProps<typeof GeminiFormFields>;

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();

  return <Form {...form}>{children}</Form>;
};

const renderGeminiForm = (overrides: Partial<GeminiFormFieldsProps> = {}) => {
  const props: GeminiFormFieldsProps = {
    shouldShowApiKey: false,
    apiKey: "tokenkey-secret",
    onApiKeyChange: vi.fn(),
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    shouldShowSpeedTest: false,
    baseUrl: "https://api.tokenkey.dev",
    onBaseUrlChange: vi.fn(),
    isEndpointModalOpen: false,
    onEndpointModalToggle: vi.fn(),
    onCustomEndpointsChange: vi.fn(),
    autoSelect: false,
    onAutoSelectChange: vi.fn(),
    shouldShowModelField: true,
    model: "gemini-3.7-flash",
    onModelChange: vi.fn(),
    speedTestEndpoints: [],
    ...overrides,
  };

  return render(
    <FormShell>
      <GeminiFormFields {...props} />
    </FormShell>,
  );
};

describe("GeminiFormFields", () => {
  beforeEach(() => {
    modelFetchApiMock.fetchModelsForConfig.mockResolvedValue([
      { id: "gemini-3.7-flash", ownedBy: null },
    ]);
  });

  it("uses the Gemini native API format when fetching models", async () => {
    renderGeminiForm();

    fireEvent.click(
      screen.getByRole("button", { name: "providerForm.fetchModels" }),
    );

    await waitFor(() => {
      expect(modelFetchApiMock.fetchModelsForConfig).toHaveBeenCalledWith(
        "https://api.tokenkey.dev",
        "tokenkey-secret",
        false,
        undefined,
        undefined,
        { apiFormat: "google-generative-ai" },
      );
    });
  });
});
