"use client";

import { useState, useTransition } from "react";
import { acknowledgeAlert } from "@/app/actions/alerts";
import { Button } from "@/components/ui";

export function AcknowledgeButton({ alertId }: { alertId: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        tone="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await acknowledgeAlert(alertId);
            if (!res.ok) setError(res.error);
          })
        }
      >
        {pending ? "Clearing…" : "Got it"}
      </Button>
      {error && <span className="text-xs text-blocked-fg">{error}</span>}
    </span>
  );
}
