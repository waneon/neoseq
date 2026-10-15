import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type TabListProps,
  type TabPanelProps,
  type TabProps,
  type TabsProps,
} from "react-aria-components";

import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: TabsProps & { className?: string }) {
  return <AriaTabs className={cn("tabs", className)} {...props} />;
}

function TabsList<T extends object>({
  className,
  ...props
}: TabListProps<T> & { className?: string }) {
  return <AriaTabList className={cn("tabs-list", className)} {...props} />;
}

function TabsTrigger({ className, ...props }: TabProps & { className?: string }) {
  return <AriaTab className={cn("tabs-trigger", className)} {...props} />;
}

function TabsContent({
  className,
  "aria-busy": busy,
  ...props
}: TabPanelProps & { className?: string; "aria-busy"?: boolean }) {
  // React Aria does not pass `aria-busy` through, and the panel is the region
  // whose content is being replaced.
  return (
    <AriaTabPanel
      ref={(node) => {
        if (busy !== undefined) node?.setAttribute("aria-busy", String(busy));
      }}
      className={cn("tabs-content", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
