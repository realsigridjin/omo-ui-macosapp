/**
 * data-testid values of the project picker, shaped like `TESTID` in `../testids` (each value is the kebab-case of its
 * key). A project row also carries `data-cwd`, and `data-selected` while it is the selected one.
 */
export const PROJECT_TESTID = {
  projectPicker: "project-picker",
  projectOption: "project-option",
  projectNew: "project-new",
  projectContinue: "project-continue",
} as const;
