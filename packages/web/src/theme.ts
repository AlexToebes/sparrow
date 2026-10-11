import { Select, createTheme } from '@mantine/core';

export const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'md',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  components: {
    // Dropdowns render in a portal on document.body so a Modal or Drawer body (which scrolls and
    // clips its content) can never cut them off. Never set `withinPortal: false` on a Select.
    // The portal z-index (popover default 300) sits above modals and drawers (200).
    Select: Select.extend({
      defaultProps: { comboboxProps: { withinPortal: true, zIndex: 400 }, maxDropdownHeight: 240 },
    }),
  },
});
