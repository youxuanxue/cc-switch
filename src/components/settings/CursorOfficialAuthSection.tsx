import { useTranslation } from "react-i18next";
import { CursorOfficialAuthControl } from "@/components/cursor/CursorOfficialAuthControl";
import { ProviderIcon } from "@/components/ProviderIcon";

export function CursorOfficialAuthSection() {
  const { t } = useTranslation();

  return (
    <section className="scroll-mt-4 rounded-xl border border-border/60 bg-card/60 p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
          <ProviderIcon icon="cursor" name="Cursor" size={20} />
        </div>
        <div>
          <h4 className="font-medium">Cursor Official</h4>
          <p className="text-sm text-muted-foreground">
            {t("settings.authCenter.cursorDescription", {
              defaultValue: "管理 Cursor Agent CLI 的官方登录与 User API Key。",
            })}
          </p>
        </div>
      </div>

      <CursorOfficialAuthControl variant="full" />
    </section>
  );
}
