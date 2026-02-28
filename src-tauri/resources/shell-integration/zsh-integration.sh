# OSC 133 shell integration for Agents UI
# Source this file in your .zshrc:
#   source /path/to/zsh-integration.sh

# Guard against double-sourcing
if [[ -n "$__AGENTS_UI_SHELL_INTEGRATION" ]]; then
  return 0
fi
__AGENTS_UI_SHELL_INTEGRATION=1

__agents_ui_precmd() {
  local exit_code=$?
  # D marker for previous command, then A marker for new prompt
  print -Pn "\e]133;D;${exit_code}\a\e]133;A\a"
}

__agents_ui_preexec() {
  # C marker when command begins executing
  print -Pn '\e]133;C\a'
}

# PREPEND to precmd so we capture $? before other hooks can modify it
precmd_functions=(__agents_ui_precmd "${precmd_functions[@]}")
preexec_functions+=(__agents_ui_preexec)

# B marker at end of prompt (marks transition from prompt to user input)
PS1="${PS1}%{\e]133;B\a%}"
