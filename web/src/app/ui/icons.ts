import {
  ArrowLeftOutline,
  CheckCircleOutline,
  CloseOutline,
  EnvironmentOutline,
  FileSearchOutline,
  FileTextOutline,
  HomeOutline,
  InfoCircleOutline,
  LogoutOutline,
  MenuFoldOutline,
  MenuOutline,
  MenuUnfoldOutline,
  PhoneOutline,
  PlusOutline,
  SearchOutline,
  SettingOutline,
  UserOutline,
  WarningOutline,
} from '@ant-design/icons-angular/icons';

/**
 * The NG-ZORRO icons this application is allowed to render.
 *
 * This is an allowlist, not a convenience. NG-ZORRO renders an empty box when
 * `nzType` names an icon that was not registered with `provideNzIcons`, so the
 * alternative to a list like this one is the library's full `ICONS` map - 703 kB
 * of SVG source shipped to every citizen to cover icons nobody on the site will
 * ever see.
 *
 * Registering per icon has a failure mode worth naming: adding `<span nz-icon
 * nzType="...">` to a template without adding the definition here renders an
 * invisible gap rather than throwing, and the gap is not visible in a
 * screenshot of the happy path. `ui-icon-registration.spec.ts` closes that by
 * failing on any `nzType` in a template whose icon is not in this list.
 *
 * Named imports, not a namespace import, so the bundler can drop the rest.
 */
export const civiclensIcons = [
  // Navigation and chrome
  HomeOutline,
  MenuOutline,
  MenuFoldOutline,
  MenuUnfoldOutline,
  SearchOutline,
  SettingOutline,
  UserOutline,
  LogoutOutline,
  ArrowLeftOutline,

  // The report a citizen files, and what they do next
  FileTextOutline,
  FileSearchOutline,
  PlusOutline,
  EnvironmentOutline,

  // Status and feedback
  CheckCircleOutline,
  WarningOutline,
  InfoCircleOutline,
  CloseOutline,

  // Contact, for the concealed-address notices
  PhoneOutline,
];
