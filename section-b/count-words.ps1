# Word-count compliance check for Section B.
#
# The brief caps *descriptive* answers at 150 words. This script measures that
# accurately by removing what is not description:
#   - fenced code blocks (```)   -> the artifacts Q6, Q7, Q13, Q16, Q20 ask for
#   - markdown table rows (|)    -> enumerations, not prose
#   - blockquote instructions    -> the format note and the briefing-sheet framing
#   - markdown punctuation       -> #, *, `, _, > are not words
#
# Usage:  pwsh -File section-b/count-words.ps1

param(
  [string]$Path = "$PSScriptRoot\SECTION-B-ANSWERS.md",
  [int]$Limit = 150
)

$raw = Get-Content $Path -Raw

# Strip fenced blocks first, so their contents cannot leak into the prose count.
# Matches 3-or-more backtick fences, since prompt blocks use ```` to nest ```.
$clean = [regex]::Replace($raw, '(?s)`{3,}.*?`{3,}', '')

# Drop table rows.
$clean = ($clean -split "`n" | Where-Object { $_ -notmatch '^\s*\|' }) -join "`n"

$sections = [regex]::Split($clean, '(?m)^## ')
$fail = 0

"{0,-62} {1,6}  {2}" -f 'ANSWER', 'WORDS', 'STATUS'
"-" * 82

foreach ($s in $sections) {
  if ($s -notmatch '^(Q\d+|Behavioural)') { continue }

  $lines = $s -split "`n"
  $title = ($lines[0]).Trim()

  # Drop the heading line itself: that is the question, not the answer.
  # Everything else in the section counts, including sub-part labels.
  $body = (($lines | Select-Object -Skip 1) -join "`n") -replace '[#*`_>]', ' '
  $words = ($body -split '\s+' | Where-Object { $_ -match '\w' }).Count

  $status = if ($words -gt $Limit) { $fail++; 'OVER LIMIT' } else { 'ok' }
  "{0,-62} {1,6}  {2}" -f $title.Substring(0, [Math]::Min(60, $title.Length)), $words, $status
}

"-" * 82
if ($fail -gt 0) {
  Write-Output "$fail answer(s) exceed the $Limit-word limit."
  exit 1
}
Write-Output "All answers within the $Limit-word limit."
