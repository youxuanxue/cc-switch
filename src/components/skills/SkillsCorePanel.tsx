import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { settingsApi } from "@/lib/api";
import {
  SKILLS_CORE_AGENTS,
  skillsCoreAgentLabel,
  skillsCoreApi,
  type SkillsCoreDoctor,
  type SkillsCorePreview,
} from "@/lib/api/skillsCore";

export interface SkillsCorePanelHandle {
  openDiscovery: () => void;
  openImport: () => void;
  syncNow: () => void;
}

interface SkillsCorePanelProps {
  onOpenDiscovery: () => void;
  onInteractionBlockedChange?: (blocked: boolean) => void;
}

const SkillsCorePanel = React.forwardRef<
  SkillsCorePanelHandle,
  SkillsCorePanelProps
>(({ onOpenDiscovery, onInteractionBlockedChange }, ref) => {
  const { t } = useTranslation();
  const [doctor, setDoctor] = useState<SkillsCoreDoctor | null>(null);
  const [preview, setPreview] = useState<SkillsCorePreview | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [installName, setInstallName] = useState("");
  const [busy, setBusy] = useState(false);

  const loadDoctor = useCallback(async () => {
    const report = await skillsCoreApi.doctor();
    setDoctor(report);
    return report;
  }, []);

  useEffect(() => {
    loadDoctor().catch((err) => {
      toast.error(String(err));
    });
  }, [loadDoctor]);

  useEffect(() => {
    onInteractionBlockedChange?.(busy);
  }, [busy, onInteractionBlockedChange]);

  const refreshPreview = useCallback(async (agents: string[]) => {
    if (agents.length === 0) {
      setPreview(null);
      setSelectedSkills([]);
      return;
    }
    const next = await skillsCoreApi.previewOpen(agents);
    setPreview(next);
    setSelectedSkills([]);
  }, []);

  const run = useCallback(
    async (action: () => Promise<SkillsCoreDoctor | void>) => {
      setBusy(true);
      try {
        const report = await action();
        if (report) {
          setDoctor(report);
        } else {
          await loadDoctor();
        }
      } catch (err) {
        toast.error(String(err));
        await loadDoctor().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [loadDoctor],
  );

  const handleOpen = useCallback(() => {
    void run(() => skillsCoreApi.open(selectedAgents, selectedSkills));
  }, [run, selectedAgents, selectedSkills]);

  const handleImport = useCallback(async () => {
    const filePath = await settingsApi.openFileDialog();
    if (!filePath) return;
    const path = filePath.endsWith("SKILL.md")
      ? filePath.replace(/[/\\]SKILL\.md$/, "")
      : filePath;
    await run(() => skillsCoreApi.importPaths([path]));
  }, [run]);

  const handleSync = useCallback(() => {
    void run(() => skillsCoreApi.sync(false));
  }, [run]);

  useImperativeHandle(
    ref,
    () => ({
      openDiscovery: onOpenDiscovery,
      openImport: () => {
        void handleImport();
      },
      syncNow: handleSync,
    }),
    [handleImport, handleSync, onOpenDiscovery],
  );

  const toggleAgent = (token: string, checked: boolean) => {
    const next = checked
      ? [...selectedAgents, token]
      : selectedAgents.filter((a) => a !== token);
    setSelectedAgents(next);
    void refreshPreview(next).catch((err) => toast.error(String(err)));
  };

  if (!doctor) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("skills.core.loading")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      {!doctor.open ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("skills.core.firstOpenTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("skills.core.firstOpenHint")}
            </p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {SKILLS_CORE_AGENTS.map((token) => (
                <label key={token} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={selectedAgents.includes(token)}
                    onCheckedChange={(checked) => toggleAgent(token, checked)}
                    disabled={busy}
                  />
                  <span>
                    {t(`skills.core.agents.${token}`, {
                      defaultValue: skillsCoreAgentLabel(token),
                    })}
                  </span>
                </label>
              ))}
            </div>
            {preview && preview.conflicts.length > 0 && (
              <p className="text-sm text-destructive">
                {t("skills.core.conflict", {
                  names: preview.conflicts.map((c) => c.name).join(", "),
                })}
              </p>
            )}
            {preview && preview.candidates.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {t("skills.core.candidates")}
                </p>
                {preview.candidates.map((cand) => (
                  <label
                    key={cand.name}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={selectedSkills.includes(cand.name)}
                      onCheckedChange={(checked) =>
                        setSelectedSkills((cur) =>
                          checked
                            ? [...cur, cand.name]
                            : cur.filter((n) => n !== cand.name),
                        )
                      }
                      disabled={busy || preview.conflicts.length > 0}
                    />
                    <span>{cand.name}</span>
                    <Badge variant="secondary">{cand.provenance}</Badge>
                  </label>
                ))}
              </div>
            )}
            <Button
              onClick={handleOpen}
              disabled={busy || selectedAgents.length === 0}
            >
              {t("skills.core.open")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t("skills.core.inUse")}</CardTitle>
              <label className="flex items-center gap-2 text-sm">
                <span>{t("skills.core.followCatalog")}</span>
                <Switch
                  checked={doctor.follow_catalog}
                  disabled={busy}
                  onCheckedChange={(on) =>
                    void run(() => skillsCoreApi.followCatalog(on))
                  }
                />
              </label>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {doctor.in_use_agents.map((token) => (
                  <Badge key={token} variant="secondary" className="gap-2">
                    {t(`skills.core.agents.${token}`, {
                      defaultValue: skillsCoreAgentLabel(token),
                    })}
                    <button
                      type="button"
                      className="text-xs underline"
                      disabled={busy}
                      onClick={() =>
                        void run(() => skillsCoreApi.agentsRemove(token))
                      }
                    >
                      {t("skills.core.remove")}
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {SKILLS_CORE_AGENTS.filter(
                  (token) => !doctor.in_use_agents.includes(token),
                ).map((token) => (
                  <Button
                    key={token}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(() => skillsCoreApi.agentsAdd(token))
                    }
                  >
                    {t("skills.core.addAgent", {
                      name: t(`skills.core.agents.${token}`, {
                        defaultValue: skillsCoreAgentLabel(token),
                      }),
                    })}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("skills.core.library")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {doctor.library.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("skills.core.libraryEmpty")}
                </p>
              ) : (
                doctor.library.map((skill) => (
                  <div
                    key={skill.name}
                    className="flex items-center justify-between gap-2 border-b py-2 last:border-0"
                  >
                    <div>
                      <div className="font-medium">{skill.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {skill.provenance}
                        {skill.behind_catalog
                          ? ` · ${t("skills.core.behind")}`
                          : ""}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(() => skillsCoreApi.uninstall([skill.name]))
                      }
                    >
                      {t("skills.uninstall")}
                    </Button>
                  </div>
                ))
              )}
              <div className="flex gap-2">
                <input
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                  placeholder={t("skills.core.installPlaceholder")}
                  value={installName}
                  onChange={(e) => setInstallName(e.target.value)}
                />
                <Button
                  disabled={busy || !installName.trim()}
                  onClick={() =>
                    void run(() =>
                      skillsCoreApi.install(
                        installName
                          .split(/[,\s]+/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      ),
                    )
                  }
                >
                  {t("skills.install")}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("skills.core.doctor")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                {t("skills.core.aligned")}:{" "}
                {doctor.projections.filter((p) => p.aligned).length}/
                {doctor.projections.length}
              </div>
              {doctor.foreign.length > 0 && (
                <div>
                  {t("skills.core.foreign")}: {doctor.foreign.join(", ")}
                </div>
              )}
              {doctor.broken.length > 0 && (
                <div className="text-destructive">
                  {t("skills.core.broken")}: {doctor.broken.join(", ")}
                </div>
              )}
              <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(doctor, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
});

SkillsCorePanel.displayName = "SkillsCorePanel";

export default SkillsCorePanel;
