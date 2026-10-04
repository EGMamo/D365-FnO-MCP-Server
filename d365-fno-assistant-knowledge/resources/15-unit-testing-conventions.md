---
appliesTo:
  tools: [get_class_hierarchy, search_symbols, get_method_signature]
match:
  names: ['*Test', '*TestCase', 'SysTestCase*']
note: "Each test method gets a fresh instance. Base insert()/update() skip validateWrite(), so call validateWrite() explicitly when testing a CoC extension of it."
---
# Unit Testing Conventions (`SysTestCase`)

> Standard framework behavior that's easy to get wrong, plus a reusable fixture pattern for
> released-product test doubles.

- Standard framework behavior (not project-specific, worth stating plainly): a fresh test-class
  instance runs *each* test method — there's no shared state between `test*` methods by default.
  `setUp()`/`tearDown()` run per method.
- Standard isolation pattern for DB-touching tests: `setUp()` does `ttsbegin`, `tearDown()` does
  `ttsabort` — everything the test creates rolls back automatically, no manual cleanup code needed.
- **Gotcha:** base table `insert()`/`update()` do *not* call `validateWrite()`/`validateDelete()`
  internally — only forms and data entities invoke those for you. A test exercising a
  Chain-of-Command-extended `validateWrite` must call it explicitly and assert the boolean return;
  calling `.update()` alone silently skips the business validation under test.
- Fixture pattern for a released-product test double: there is no product-builder convenience
  class in the platform — insert a minimal distinct-product record, then release it through the
  platform's standard release-manager API against the current legal entity to get a real
  `InventTable` row. Wrap this in one shared test-helper class rather than repeating it per test.
- General verification habit: before trusting a recalled API name/shape (e.g. "is there a builder
  class for X"), grep the actual installed platform package metadata rather than relying on
  training-data recall — plausible-sounding helper classes that don't exist in a given version are
  a recurring failure mode.
