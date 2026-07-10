import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { copyText, intercomContactText } from "./contact.ts";

const module: TuiPluginModule = {
  id: "opencode-intercom-contact",
  tui: async (api) => {
    api.command?.register(() => [{
      title: "Copy intercom contact",
      value: "intercom.contact.copy",
      description: "Copy this OpenCode session's stable intercom target",
      category: "Intercom",
      keybind: "alt+i",
      slash: { name: "intercom-contact" },
      onSelect: () => {
        const contact = intercomContactText();
        api.ui.toast({
          title: "Intercom",
          message: copyText(contact) ? `Copied: ${contact}` : contact,
          variant: "success",
          duration: 5000,
        });
      },
    }]);
  },
};

export default module;
