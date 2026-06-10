"use client";

import { ExportPanel } from "./ExportPanel";
import { LogConsole } from "./LogConsole";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download, Terminal } from "lucide-react";

interface BottomDrawerProps {
  engine: any;
}

export function BottomDrawer({ engine }: BottomDrawerProps) {
  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface)]">
      <Tabs defaultValue="export" className="w-full">
        <TabsList className="bg-transparent h-auto p-0 border-b-0 rounded-none">
          <TabsTrigger
            value="export"
            className="flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-wider rounded-none border-b-2 border-transparent data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--accent)] data-[state=inactive]:text-[var(--text-dim)] data-[state=inactive]:hover:text-[var(--text-bright)] bg-transparent"
          >
            <Download className="w-3.5 h-3.5" /> EXPORT
          </TabsTrigger>
          <TabsTrigger
            value="console"
            className="flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-wider rounded-none border-b-2 border-transparent data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--accent)] data-[state=inactive]:text-[var(--text-dim)] data-[state=inactive]:hover:text-[var(--text-bright)] bg-transparent"
          >
            <Terminal className="w-3.5 h-3.5" /> CONSOLE
          </TabsTrigger>
        </TabsList>
        <TabsContent value="export" className="mt-0 border-t border-[var(--border)] p-4">
          <ExportPanel engine={engine} />
        </TabsContent>
        <TabsContent value="console" className="mt-0 border-t border-[var(--border)]">
          <LogConsole />
        </TabsContent>
      </Tabs>
    </div>
  );
}
