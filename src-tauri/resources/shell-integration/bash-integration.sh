# OSC 133 shell integration for Agents UI
# Source this file in your .bashrc or .bash_profile:
#   source /path/to/bash-integration.sh

# Guard against double-sourcing
if [[ -n "$__AGENTS_UI_SHELL_INTEGRATION" ]]; then
  return 0
fi
__AGENTS_UI_SHELL_INTEGRATION=1

__agents_ui_prompt_start() {
  printf '\e]133;A\a'
}

__agents_ui_prompt_end() {
  printf '\e]133;B\a'
}

__agents_ui_command_start() {
  # Only emit C if a command is actually being executed (not empty enter)
  if [[ -n "$BASH_COMMAND" && "$BASH_COMMAND" != "$PROMPT_COMMAND" ]]; then
    printf '\e]133;C\a'
  fi
}

__agents_ui_command_finished() {
  local exit_code=$?
  printf '\e]133;D;%s\a' "$exit_code"
}

# Wire into bash hooks:
# 1. D marker (from previous command) + A marker before prompt renders
# 2. B marker appended to PS1 after prompt renders
# 3. C marker via DEBUG trap when command executes

__agents_ui_prompt_hook() {
  __agents_ui_command_finished
  __agents_ui_prompt_start
}

if [[ -n "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND="__agents_ui_prompt_hook;${PROMPT_COMMAND}"
else
  PROMPT_COMMAND="__agents_ui_prompt_hook"
fi

PS1="${PS1}\[\e]133;B\a\]"

trap '__agents_ui_command_start' DEBUG
