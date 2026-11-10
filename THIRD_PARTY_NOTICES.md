# Third-party notices

The root [MIT license](LICENSE) applies to HAF Bot's original work. Dependencies and copied
components retain their own copyright notices and licenses.

| Component                            | License and notice                                                                               | Use                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `sentry-to-github-issues` derivative | [MIT, copyright caezium](LICENSES/sentry-to-github-issues-MIT.txt)                               | Sentry issue-monitor tooling                              |
| Oxanium font                         | [SIL Open Font License 1.1, copyright the Oxanium Project Authors](LICENSES/Oxanium-OFL-1.1.txt) | Dashboard font supplied by `@fontsource-variable/oxanium` |

JavaScript packages carry their notices in their installed package directories. Inspect the locked
dependency trees separately: the root manifest includes frontend and development tooling, while
`packages/node-runtime` defines the smaller production container dependency tree.

```sh
pnpm licenses list --prod --json
pnpm --dir packages/node-runtime install --prod --frozen-lockfile --ignore-scripts
pnpm --dir packages/node-runtime licenses list --prod --json
```

Review the output before publishing it: package paths can contain the operator's local username
and checkout location. Keep required notices when redistributing bundles, fonts or images.
An inventory of package metadata is not a complete notice bundle or a rights review.

The locked Sentry Node 11 dependency tree includes the `sentry` CLI package, version 0.45.0,
under [FSL-1.1-Apache-2.0](https://github.com/getsentry/cli/blob/0.45.0/LICENSE.md).
HAF's MIT license does not relicense that dependency or remove its conditions. This source
archive contains locked manifests rather than installed dependencies or a prebuilt image.
Retain the package's copyright and license when distributing copies of that dependency.

The root tree currently includes MPL-2.0 `lightningcss` packages and an LGPL-3.0-or-later libvips
package through development tooling. Their presence in the source-build environment does not mean
they ship in the final application image. Verify each actual distributed artifact and retain the
applicable notices/source obligations rather than labelling all dependencies MIT.

On 10 November 2026 the owner confirmed that HAF's logo/banner artwork and the older
`docs-site/public/images/admin-overview.png` screenshot are cleared for MIT redistribution;
the screenshot contains only demo data. Generated dashboard captures use fictional fixtures,
as documented in `scripts/admin-docs/README.md`.
The source license does not grant rights to Discord, provider or other third-party trademarks,
or endorsement by HAF's hosted service. See the [release guidance](CONTRIBUTING.md).
