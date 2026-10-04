---
appliesTo:
  tools: [find_usages, get_method_signature, check_xpp_best_practices, get_bp_findings, search_trace]
match:
  names: ['tts*', '*ttsbegin*', '*ttscommit*', '*ttsabort*']
note: "Inside try/catch put ttsbegin first and ttscommit last in the try. Never call ttsabort in the catch: the kernel already aborted, and a manual abort raises BPErrorMethodUnbalancedTtsbeginCommit."
---
# Transactions (`ttsbegin`/`ttscommit`/`ttsabort`)

> The correct, BP-clean shape for a per-item try/catch around a transaction — and the two ways to
> get it wrong.

```xpp
try
{
    ttsbegin;
    // ... work ...
    ttscommit;
}
catch (Exception::Error)
{
    // Do NOT call ttsabort here.
    // ... handle / log / continue ...
}
```

- `ttsbegin` first inside `try`, `ttscommit` last inside `try`.
- **Do not put `ttsabort` in the catch.** When an exception leaves the `try` (crossing `ttsbegin`
  without `ttscommit`), the kernel **auto-aborts**; a manual `ttsabort` then runs at tts level 0 =
  `BPErrorMethodUnbalancedTtsbeginCommit`.
- **Do not** move `ttsbegin` before the `try` — that splits begin/commit/abort across scopes and
  produces several unbalanced-tts warnings.
