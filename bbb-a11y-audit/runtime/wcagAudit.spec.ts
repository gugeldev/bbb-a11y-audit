import { devices, Page as PlaywrightPage, TestInfo } from '@playwright/test';

import { ELEMENT_WAIT_EXTRA_LONG_TIME, ELEMENT_WAIT_LONGER_TIME, ELEMENT_WAIT_TIME } from '../core/constants';
import { elements as e } from '../core/elements';
import { ClientSettingsOverrides, Page } from '../core/page';
import { test } from '../core/setup/fixtures';
import { answerPollOption, openPoll, startPoll } from '../polling/util';
import { PRE_FLIGHT_CREATE_PARAMETER, PRE_FLIGHT_INIT_OPTIONS, refuseDevices } from '../pre-flight/util';
import { EXTERNAL_VIDEO_URL, routeExternalVideo } from '../presentation/util';
import { routeServerConnection, SHOW_RECONNECTING_TOAST } from '../reconnection/util';
import { startScreenshare } from '../screenshare/util';
import { MultiUsers } from '../user/multiusers';
import { openLockViewers, setGuestPolicyOption, setPresentationPermission } from '../user/util';
import { findNonTextContrastViolations } from './nonTextContrast';
import { clearAnnouncements, ensureAnnouncementRecorder, installAnnouncementRecorder } from './wcagAuditAnnouncements';
import {
  checkFocusReturn,
  checkHoverFocus,
  checkKeyboard,
  checkMenuSelection,
  checkReflow,
  checkStateChange,
  checkTextSpacing,
} from './wcagAuditChecks';
import {
  auditOutDir,
  AuditRecorder,
  errorMessage,
  pressEscape,
  ScenarioInfo,
  StateOptions,
  wants,
} from './wcagAuditRecorder';

/**
 * WCAG 2.2 AA runtime audit used by the bbb-a11y-audit agent skill.
 *
 * This is an audit, not a regression test: it never fails because of violations. Each test is one
 * scenario and writes <A11Y_AUDIT_DIR>/<scenario>.json plus screenshots. Not tagged @ci, so it never
 * runs in CI. With A11Y_GUIDELINES set, scenarios and checks that cannot inform the topic are skipped.
 *
 *   A11Y_AUDIT_DIR=/abs/dir npx playwright test accessibility/wcagAudit.spec.ts --project=chromium --workers=1
 */

const SCENARIO_TIMEOUT = 15 * 60 * 1000;
const ANNOUNCEMENT_WAIT_MS = 2000;
const BREAKOUT_IDLE_MS = 30000;
const ROOM_LOAD_TIMEOUT = 3 * ELEMENT_WAIT_EXTRA_LONG_TIME;
const ACCEPT_GUEST = '[data-test="acceptGuest"]';
const PRIVATE_MESSAGE_GUEST = '[data-test="privateMessageGuest"]';
const PRIVATE_LOBBY_MESSAGE = '[data-test="privateLobbyMessage"]';
const TIME_REMAINING = '[data-test="timeRemaining"]';
// The recording controls (and their confirmation) only exist in meetings created to be recorded.
const RECORDED_MEETING = 'record=true';
// Moderators can only ask an attendee to share the camera in meetings created with this.
const CAMERA_REQUESTS_ALLOWED = 'allowModsToRequestCameraShare=true';
// Off by default in 4.1, but deployments turn it on: audit it too.
const CHAT_EMOJI_PICKER_ON: ClientSettingsOverrides = { public: { chat: { emojiPicker: { enable: true } } } };
const LIVE_REGION = '[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]';

type Steps = Pick<StateOptions, 'enter' | 'leave'>;

// State ids of tabs that existing findings already point at, keyed by the tab's (English) label.
// Any other tab gets an id built from its label, so a tab added later is audited too.
const TAB_STATE_IDS: Record<string, string> = {
  Notifications: 'settings-notifications',
  'Data savings': 'settings-data-saving',
  Audio: 'settings-audio',
  'Keyboard shortcuts': 'settings-shortcuts',
  About: 'settings-about',
  'Guest Policy': 'guest-policy',
  'Presentation Policy': 'presentation-policy',
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

interface TabsOptions {
  /** Prefix of the state ids of tabs without a known id. */
  idPrefix: string;
  /** Prefix of the state names (what the report shows). */
  namePrefix: string;
  /** Labels of tabs that belong to an outer tab list, so they are not audited again. */
  skip?: string[];
  /** Also audit the tabs that appear inside each tab (one level). */
  nested?: boolean;
}

async function visibleTabs(page: PlaywrightPage) {
  return page.locator('[role="tab"]:visible').evaluateAll((tabs) =>
    tabs.map((tab) => ({
      label: (tab.textContent || '').trim(),
      selected: tab.getAttribute('aria-selected') === 'true',
    })),
  );
}

/**
 * Audits every tab on screen that is not already selected (the selected one was audited when its
 * dialog opened). Tabs are read from the page, not listed by hand, so none is left out when the
 * client adds one. Returns to the tab that was selected, so the dialog is left as it was found.
 */
async function auditTabs(rec: AuditRecorder, user: Page, options: TabsOptions) {
  const { idPrefix, namePrefix, skip = [], nested = false } = options;
  const tabs = (await visibleTabs(user.page)).filter((tab) => tab.label && !skip.includes(tab.label));
  const tabNamed = (label: string) => user.page.locator('[role="tab"]:visible').filter({ hasText: label }).first();
  const initiallySelected = tabs.find((tab) => tab.selected);

  for (const tab of tabs.filter((t) => !t.selected)) {
    const id = TAB_STATE_IDS[tab.label] || `${idPrefix}-${slug(tab.label)}`;
    const name = `${namePrefix}: ${tab.label}`;
    const opened = await rec.state(user.page, {
      id,
      name,
      description: `Aba "${tab.label}" de ${namePrefix}.`,
      enter: () => tabNamed(tab.label).click(),
    });
    if (opened && nested) {
      await auditTabs(rec, user, { idPrefix: id, namePrefix: name, skip: [...skip, ...tabs.map((t) => t.label)] });
    }
  }
  if (initiallySelected)
    await tabNamed(initiallySelected.label)
      .click()
      .catch(() => undefined);
}

/** A menu, popover or modal: opened by clicking `trigger`, closed with Escape. */
const opensWith = (user: Page, trigger: string): Steps => ({
  enter: () => user.waitAndClick(trigger),
  leave: () => pressEscape(user.page),
});

/** A panel or mode switched on and off by the same control. */
const togglesWith = (user: Page, trigger: string): Steps => ({
  enter: () => user.waitAndClick(trigger),
  leave: () => user.waitAndClick(trigger),
});

/**
 * Runs one scenario: records everything into its JSON even when a step fails halfway, so a broken
 * flow shows up in the report as states that were not audited instead of a missing scenario.
 */
async function auditScenario(testInfo: TestInfo, scenario: ScenarioInfo, body: (rec: AuditRecorder) => Promise<void>) {
  test.setTimeout(SCENARIO_TIMEOUT);
  const rec = new AuditRecorder(scenario, auditOutDir(testInfo.outputPath('a11y-audit')));
  try {
    await body(rec);
  } catch (err) {
    rec.note('scenarioError', errorMessage(err, { lines: 2, max: 500 }));
  } finally {
    rec.write();
  }
}

/** Skips the current scenario when none of `topics` overlaps the requested topic. */
function skipUnlessTopic(...topics: string[]) {
  test.skip(!wants(...topics), 'not relevant to the selected topic');
}

async function openUserList(user: Page) {
  // isVisible() is a snapshot and is racy right after join: wait for the panel state instead.
  const isOpen = await user.page
    .locator(e.userListPanel)
    .waitFor({ state: 'visible', timeout: ELEMENT_WAIT_TIME })
    .then(() => true)
    .catch(() => false);
  if (!isOpen) {
    await user.waitAndClick(e.usersListSidebarButton);
    await user.hasElement(e.userListPanel, 'should open the user list panel');
  }
}

async function openPublicChat(user: Page) {
  const { page } = user;
  if (!(await page.locator(e.hidePublicChat).isVisible())) {
    // Mobile layout: the sidebar navigation is collapsed behind a toggle button.
    const sidebarToggle = page.locator(e.toggleSidebarNavigation).first();
    if (await sidebarToggle.isVisible()) {
      await sidebarToggle.click();
      await page.waitForTimeout(1500);
    }
    await page.locator(e.messagesSidebarButton).first().click();
    await page.waitForTimeout(1000);
    const chatButton = page.locator(e.chatButton).first();
    if (!(await page.locator(e.hidePublicChat).isVisible()) && (await chatButton.isVisible())) {
      await chatButton.click();
    }
  }
  await user.hasElement(e.hidePublicChat, 'should display the public chat');
}

async function sendChatMessage(user: Page, text: string) {
  await user.page.locator(e.chatBox).fill(text);
  await user.waitAndClick(e.sendButton);
}

async function sendChatMessages(user: Page, texts: string[]) {
  for (const text of texts) {
    await sendChatMessage(user, text);
    await user.page.waitForTimeout(400);
  }
}

/** The checks every main screen gets: keyboard walk, reflow, text spacing and non-text contrast. */
async function standardChecks(rec: AuditRecorder, page: PlaywrightPage, prefix = '') {
  await rec.check(`${prefix}keyboard`, () => checkKeyboard(page), ['2.1', '2.4']);
  await rec.check(`${prefix}reflow`, () => checkReflow(page), ['1.4']);
  await rec.check(`${prefix}textSpacing`, () => checkTextSpacing(page), ['1.4']);
  await rec.check(`${prefix}nonTextContrast`, () => findNonTextContrastViolations(page), ['1.4']);
}

async function runSequentially<T>(items: string[], run: (item: string) => Promise<T>) {
  const results: T[] = [];
  for (const item of items) results.push(await run(item));
  return results;
}

// ---------------------------------------------------------------------------------------------
// Moderator tour, in steps
// ---------------------------------------------------------------------------------------------

/** Which server and client build were audited (shown in the report). */
async function noteAuditedServer(rec: AuditRecorder, mod: Page) {
  const clientVersion = await mod.page.evaluate(() => {
    // @ts-ignore - injected on window by the client at runtime
    const app = window.meetingClientSettings?.public?.app || {};
    return { bbbServerVersion: app.bbbServerVersion || null, html5ClientBuild: app.html5ClientBuild || null };
  });
  rec.note('server', { url: (process.env.BBB_URL || '').replace(/\/bigbluebutton\/?$/, ''), ...clientVersion });
}

async function auditJoiningAudio(rec: AuditRecorder, mod: Page) {
  await rec.state(mod.page, {
    id: 'audio-modal',
    name: 'Modal de áudio',
    description: 'Primeira tela após entrar: escolha de como participar do áudio.',
    enter: () => mod.hasElement(e.audioModal, 'audio modal'),
  });
  await rec.state(mod.page, {
    id: 'audio-echo-test',
    name: 'Teste de eco',
    description: 'Etapa em que a pessoa confirma se está se ouvindo.',
    enter: async () => {
      await mod.clickMicrophoneButton();
      await mod.waitForSelector(e.stopHearingButton);
    },
  });
  await rec.state(mod.page, {
    id: 'meeting',
    name: 'Sala com áudio conectado',
    description: 'Estado principal da reunião, microfone conectado e mutado.',
    enter: async () => {
      // Same sequence as Page.joinMicrophone: with LiveKit, establishing audio takes several seconds.
      await mod.waitAndClick(e.joinEchoTestButton);
      await mod.wasRemoved(e.establishingAudioLabel, 'should establish audio', ELEMENT_WAIT_LONGER_TIME);
      await mod.hasElement(e.unmuteMicButton, 'should be in audio', ELEMENT_WAIT_LONGER_TIME);
    },
  });
}

/** Interaction checks on the main meeting screen: focus return, tooltips, toggles and device menus. */
async function checkMeetingControls(rec: AuditRecorder, page: PlaywrightPage) {
  const menuTriggers = [e.audioDropdownMenu, e.mediaAreaButton, e.optionsButton, e.leaveMeetingDropdown];

  await rec.check(
    'focusReturn',
    () => runSequentially([...menuTriggers, e.settingsSidebarButton], (trigger) => checkFocusReturn(page, trigger)),
    ['2.4', '2.1', '3.2'],
  );
  await rec.check(
    'hoverFocus',
    () =>
      checkHoverFocus(page, [
        e.joinVideo,
        e.unmuteMicButton,
        e.raiseHandBtn,
        e.reactionsButton,
        e.mediaAreaButton,
        e.leaveMeetingDropdown,
        e.connectionStatusBtn,
        e.settingsSidebarButton,
        e.usersListSidebarButton,
      ]),
    ['1.4'],
  );
  await rec.check(
    'stateChanges',
    async () => [
      ...(await runSequentially([e.unmuteMicButton, e.raiseHandBtn], (toggle) =>
        checkStateChange(page, toggle, 'click'),
      )),
      ...(await runSequentially([...menuTriggers, e.reactionsButton], (trigger) =>
        checkStateChange(page, trigger, 'escape'),
      )),
    ],
    ['4.1', '1.3'],
  );
  await rec.check(
    'deviceSelection',
    () =>
      runSequentially(['[id^="audioinput-"]', '[id^="audiooutput-"]'], (items) =>
        checkMenuSelection(page, e.audioDropdownMenu, items),
      ),
    ['4.1', '1.3'],
  );
}

async function auditPeopleAndChat(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'audio-menu',
    name: 'Menu de áudio',
    description: 'Menu de dispositivos e saída do áudio.',
    ...opensWith(mod, e.audioDropdownMenu),
  });
  await rec.state(page, {
    id: 'user-list',
    name: 'Lista de usuários',
    description: 'Painel de participantes.',
    enter: () => openUserList(mod),
  });
  await rec.check('keyboard-user-list', () => checkKeyboard(page, 60), ['2.1', '2.4']);
  await rec.state(page, {
    id: 'user-item-menu',
    name: 'Menu de um participante',
    description: 'Menu aberto ao clicar no próprio nome na lista.',
    ...opensWith(mod, e.currentUser),
  });
  await rec.state(page, {
    id: 'lock-viewers',
    name: 'Travar participantes',
    description: 'Modal de bloqueio de recursos dos participantes, aba inicial.',
    enter: () => openLockViewers(mod),
  });
  await auditTabs(rec, mod, { idPrefix: 'lock-viewers', namePrefix: 'Permissões' });
  await pressEscape(page);
  await rec.state(page, {
    id: 'public-chat',
    name: 'Chat público',
    description: 'Painel de chat público aberto.',
    enter: async () => {
      await openPublicChat(mod);
      await sendChatMessage(mod, 'Mensagem de teste da auditoria');
    },
  });
  await rec.check('keyboard-public-chat', () => checkKeyboard(page, 60), ['2.1', '2.4']);
  await rec.state(page, {
    id: 'chat-options',
    name: 'Opções do chat',
    description: 'Menu de opções do chat (salvar, copiar, limpar).',
    ...opensWith(mod, e.chatOptions),
  });
  await rec.state(page, {
    id: 'chat-emoji-picker',
    name: 'Emojis no campo do chat',
    description: 'Seletor de emoji aberto pelo botão ao lado do campo de mensagem.',
    enter: () => mod.waitAndClick(e.emojiPickerButton),
    leave: () => dismiss(mod),
  });
  await auditChatMessageActions(rec, mod);
}

/** Shows the toolbar of the last chat message, which only appears while the message is hovered. */
async function hoverLastChatMessage(user: Page) {
  const message = user.page.locator(e.chatMessageItem).last();
  await message.hover();
  await message.locator(e.messageToolbar).waitFor({ state: 'visible' });
  return message;
}

/**
 * Closes a popover so it does not cover the next states: Escape, then a click outside. The emoji
 * pickers (emoji-mart) spend the first Escape leaving their search field; the reaction picker closes
 * on a second one, the chat input picker did not close with Escape at all in 4.1 (to confirm by hand).
 */
async function dismiss(user: Page) {
  await pressEscape(user.page);
  await user.page.mouse.click(1, 1);
}

/** A chat message action: hover the last message, click one of its toolbar buttons. */
const messageAction = (user: Page, button: string, opens?: string): Steps => ({
  enter: async () => {
    const message = await hoverLastChatMessage(user);
    await message.locator(button).click();
    if (opens) await user.hasElement(opens, `should open ${opens}`);
  },
  leave: () => dismiss(user),
});

async function auditChatMessageActions(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'chat-message-toolbar',
    name: 'Ações de uma mensagem',
    description: 'Barra de ações (reagir, responder, editar, fixar, apagar) ao passar sobre uma mensagem.',
    enter: () => hoverLastChatMessage(mod),
    leave: () => page.mouse.move(1, 1),
  });
  await rec.state(page, {
    id: 'chat-react-picker',
    name: 'Reagir a uma mensagem',
    description: 'Seletor de reação aberto a partir de uma mensagem.',
    ...messageAction(mod, e.reactMessageButton),
  });
  await rec.state(page, {
    id: 'chat-reply',
    name: 'Respondendo uma mensagem',
    description: 'Campo do chat em modo de resposta, com a mensagem citada.',
    ...messageAction(mod, e.replyMessageButton),
  });
  await rec.state(page, {
    id: 'chat-pin-confirm',
    name: 'Confirmar fixar mensagem',
    description: 'Modal de confirmação para fixar uma mensagem no topo do chat.',
    ...messageAction(mod, e.pinMessageButton, e.simpleModal),
  });
  await rec.state(page, {
    id: 'chat-delete-confirm',
    name: 'Confirmar apagar mensagem',
    description: 'Modal de confirmação para apagar uma mensagem.',
    ...messageAction(mod, e.deleteMessageButton, e.simpleModal),
  });
}

async function auditSettingsAndTools(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'settings',
    name: 'Configurações',
    description: 'Modal de configurações, aba inicial.',
    enter: () => mod.waitAndClick(e.settingsSidebarButton),
  });
  // Inside an open modal: focus must stay in the dialog (and not escape to the page behind it).
  await rec.check('keyboard-settings-modal', () => checkKeyboard(page, 40), ['2.1', '2.4']);
  await auditTabs(rec, mod, { idPrefix: 'settings', namePrefix: 'Configurações', nested: true });
  await pressEscape(page);
  await rec.state(page, {
    id: 'poll-create',
    name: 'Criar enquete',
    description: 'Painel de criação de enquete com alternativas.',
    enter: () => openPoll(mod),
  });
  await rec.state(page, {
    id: 'poll-running',
    name: 'Enquete em andamento',
    description: 'Visão do moderador com a enquete iniciada.',
    enter: () => mod.waitAndClick(e.startPoll),
    leave: async () => {
      await mod.waitAndClick(e.publishPollingLabel);
      await mod.closeAllToastNotifications();
    },
  });
  await rec.state(page, {
    id: 'breakout',
    name: 'Salas de apoio',
    description: 'Painel de criação de salas de apoio (breakout).',
    ...togglesWith(mod, e.breakoutRoomSidebarButton),
  });
  await rec.state(page, {
    id: 'shared-notes',
    name: 'Notas compartilhadas',
    description: 'Editor de notas compartilhadas.',
    enter: async () => {
      await mod.waitAndClick(e.sharedNotesSidebarButton);
      await mod.hasElement(e.sharedNotesBackground, 'should display shared notes');
    },
  });
  await rec.state(page, {
    id: 'notes-options',
    name: 'Opções das notas',
    description: 'Menu das notas compartilhadas (exportar, fixar no lugar da apresentação).',
    ...opensWith(mod, e.notesOptions),
  });
  if (await mod.checkElement(e.sharedNotesBackground)) await mod.waitAndClick(e.sharedNotesSidebarButton);
  await rec.state(page, {
    id: 'apps-gallery',
    name: 'Galeria de apps',
    description: 'Painel com os apps disponíveis para a reunião.',
    enter: async () => {
      await mod.waitAndClick(e.appsGallerySidebarButton);
      await mod.hasElement(e.appsGalleryTitle, 'should open the apps gallery');
    },
    leave: () => mod.waitAndClick(e.appsGallerySidebarButton),
  });
  await rec.state(page, {
    id: 'layout-view',
    name: 'Escolha de layout',
    description: 'Painel de visualização do layout da reunião (só para moderadores).',
    enter: async () => {
      await mod.waitAndClick(e.layoutViewButton);
      await mod.hasElement(e.layoutViewPanel, 'should open the layout view panel');
    },
    leave: () => pressEscape(page),
  });
  await rec.state(page, {
    id: 'recording-confirm',
    name: 'Confirmar gravação',
    description: 'Confirmação mostrada ao clicar para iniciar a gravação.',
    enter: async () => {
      await mod.waitAndClick(e.recordingIndicator);
      await mod.hasElement(e.confirmRecordingButton, 'should ask to confirm the recording');
    },
    leave: () => mod.waitAndClick(e.cancelRecordingButton),
  });
  await rec.state(page, {
    id: 'timer',
    name: 'Timer e cronômetro',
    description: 'Painel de timer.',
    ...togglesWith(mod, e.timerStopwatchFeature),
  });
  await rec.state(page, {
    id: 'reactions',
    name: 'Reações',
    description: 'Barra de reações aberta.',
    ...opensWith(mod, e.reactionsButton),
  });
  await rec.state(page, {
    id: 'raise-hand',
    name: 'Mão levantada',
    description: 'Estado com a mão levantada.',
    ...togglesWith(mod, e.raiseHandBtn),
  });
}

async function auditMediaAndSharing(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'media-area-menu',
    name: 'Menu da área de mídia',
    description: 'Menu de compartilhamento (apresentação, vídeo externo, etc.).',
    ...opensWith(mod, e.mediaAreaButton),
  });
  await rec.state(page, {
    id: 'presentation-upload',
    name: 'Enviar apresentação',
    description: 'Modal de gerenciamento e upload de apresentações.',
    enter: async () => {
      await mod.waitAndClick(e.mediaAreaButton);
      await mod.waitAndClick(e.managePresentations);
    },
  });
  await rec.state(page, {
    id: 'presentation-download-menu',
    name: 'Opções de download da apresentação',
    description: 'Menu de download de uma apresentação, dentro do modal de apresentações.',
    enter: () => mod.waitAndClick(e.presentationOptionsDownloadBtn),
    leave: async () => {
      await pressEscape(page);
      await pressEscape(page);
    },
  });
  await rec.state(page, {
    id: 'presentation-menu',
    name: 'Menu da apresentação',
    description: 'Opções da apresentação (tela cheia, foto do slide, ajustar à largura).',
    ...opensWith(mod, e.whiteboardOptionsButton),
  });
  await auditExternalVideo(rec, mod);
  await rec.state(page, {
    id: 'whiteboard-toolbar',
    name: 'Ferramentas do quadro branco',
    description: 'Barra de ferramentas do quadro branco (presenter).',
    enter: () => mod.hasElement(e.wbToolbar, 'should display the whiteboard toolbar'),
  });
  await rec.state(page, {
    id: 'whiteboard-menu',
    name: 'Menu do quadro branco',
    description: 'Menu principal do quadro branco.',
    ...opensWith(mod, e.wbOptions),
  });
  await rec.state(page, {
    id: 'webcam-preview',
    name: 'Prévia da webcam',
    description: 'Modal de prévia e configuração da câmera.',
    enter: async () => {
      await mod.waitAndClick(e.joinVideo);
      await mod.hasElement(e.startSharingWebcam, 'should display the webcam preview');
    },
  });
  await auditTabs(rec, mod, { idPrefix: 'webcam-preview', namePrefix: 'Prévia da webcam' });
  await rec.state(page, {
    id: 'webcam-on',
    name: 'Webcam compartilhada',
    description: 'Sala com a câmera do moderador ligada.',
    enter: async () => {
      await mod.waitAndClick(e.startSharingWebcam);
      await mod.hasElement(e.leaveVideo, 'should share the webcam');
    },
  });
  await rec.state(page, {
    id: 'webcam-button-menu',
    name: 'Menu do botão de câmera',
    description: 'Menu ao lado do botão de câmera (configurações, fundo virtual).',
    ...opensWith(mod, e.videoDropdownMenu),
  });
  await rec.state(page, {
    id: 'webcam-menu',
    name: 'Menu do vídeo',
    description: 'Menu de opções sobre o vídeo de um participante.',
    enter: () => mod.waitAndClick(e.dropdownWebcamButton),
    leave: async () => {
      await pressEscape(page);
      await mod.waitAndClick(e.leaveVideo);
    },
  });
  await rec.state(page, {
    id: 'screenshare',
    name: 'Compartilhando a tela',
    description: 'Sala com compartilhamento de tela ativo.',
    enter: () => startScreenshare(mod),
    leave: () => mod.waitAndClick(e.stopScreenSharing),
  });
}

/** External video, served by the suite's stub so it does not depend on the internet. */
async function auditExternalVideo(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await routeExternalVideo(page.context());
  await rec.state(page, {
    id: 'external-video-modal',
    name: 'Compartilhar vídeo externo',
    description: 'Modal para colar o endereço de um vídeo externo.',
    enter: async () => {
      await mod.waitAndClick(e.mediaAreaButton);
      await mod.waitAndClick(e.shareExternalVideoBtn);
      await mod.hasElement(e.videoModalInput, 'should display the external video address field');
    },
  });
  await rec.state(page, {
    id: 'external-video-playing',
    name: 'Vídeo externo tocando',
    description: 'Sala com um vídeo externo compartilhado e o player aberto.',
    enter: async () => {
      await mod.page.locator(e.videoModalInput).first().fill(EXTERNAL_VIDEO_URL);
      await mod.waitAndClick(e.startShareVideoBtn);
      await pressEscape(page); // the media sharing menu stays open
      await mod.hasElement(e.externalVideo, 'should display the external video', ELEMENT_WAIT_LONGER_TIME);
    },
    leave: async () => {
      await mod.closeAllToastNotifications();
      await mod.waitAndClick(e.stopExternalVideoBtn);
    },
  });
}

async function auditMeetingMenus(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'session-details',
    name: 'Detalhes da sessão',
    description: 'Modal com informações da reunião.',
    ...opensWith(mod, e.sessionDetailsButton),
  });
  await rec.state(page, {
    id: 'connection-status',
    name: 'Status da conexão',
    description: 'Modal de status da conexão, aba inicial.',
    enter: () => mod.waitAndClick(e.connectionStatusBtn),
  });
  await auditTabs(rec, mod, { idPrefix: 'connection-status', namePrefix: 'Status da conexão' });
  await pressEscape(page);
  await rec.state(page, {
    id: 'options-menu',
    name: 'Menu de opções',
    description: 'Menu geral (tela cheia, sobre, sair...).',
    ...opensWith(mod, e.optionsButton),
  });
  await rec.state(page, {
    id: 'leave-menu',
    name: 'Menu de sair',
    description: 'Menu do botão de saída da reunião.',
    enter: () => mod.waitAndClick(e.leaveMeetingDropdown),
  });
  await rec.state(page, {
    id: 'end-meeting',
    name: 'Confirmar encerramento',
    description: 'Modal de confirmação para encerrar a reunião para todos.',
    enter: () => mod.waitAndClick(e.endMeetingButton),
  });
}

/** Last step of a tour: the moderator ends the meeting and lands on the "meeting ended" screen. */
async function auditMeetingEnded(rec: AuditRecorder, mod: Page) {
  await rec.state(mod.page, {
    id: 'meeting-ended',
    name: 'Reunião encerrada',
    description: 'Tela mostrada depois que o moderador encerra a reunião para todos.',
    enter: async () => {
      await mod.waitAndClick(e.confirmEndMeetingButton);
      await mod.hasElement(e.meetingEndedModal, 'should display the meeting ended screen', ELEMENT_WAIT_LONGER_TIME);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Moderator and attendee, in steps
// ---------------------------------------------------------------------------------------------

/** Opens the options menu of the attendee's row in the moderator's user list. */
async function openAttendeeMenu(mod: Page) {
  await openUserList(mod);
  await mod.waitAndClick(e.otherUserMoreOptionsButton);
}

async function auditModeratingAttendee(rec: AuditRecorder, mod: Page, att: Page) {
  await rec.state(mod.page, {
    id: 'mod-attendee-menu',
    name: 'Menu de um participante (moderador)',
    description: 'Opções do moderador sobre outro participante (apresentador, promover, câmera, remover).',
    actor: 'moderator',
    enter: () => openAttendeeMenu(mod),
    leave: () => pressEscape(mod.page),
  });
  await rec.state(att.page, {
    id: 'attendee-camera-request',
    name: 'Pedido para ligar a câmera (participante)',
    description: 'Pedido do moderador para o participante compartilhar a câmera.',
    actor: 'attendee',
    enter: async () => {
      await openAttendeeMenu(mod);
      // Every row renders its own copy of the menu; only the open one is visible.
      await mod.page.locator(`${e.requestUserCamera}:visible`).first().click();
      await att.hasElement(
        e.confirmShareCamera,
        'should ask the attendee to share the camera',
        ELEMENT_WAIT_LONGER_TIME,
      );
    },
    leave: () => att.waitAndClick(e.denyShareCamera),
  });
}

/** With presenter requests needing approval: the attendee asks to present and the moderator decides. */
async function auditPresenterRequest(rec: AuditRecorder, mod: Page, att: Page) {
  try {
    await setPresentationPermission(mod, e.presRequireApproval);
  } catch (err) {
    rec.note('presenterRequestSetupError', errorMessage(err));
  }
  await rec.state(att.page, {
    id: 'attendee-request-presenter',
    name: 'Pedir para apresentar (participante)',
    description: 'Menu de mídia do participante com a opção de pedir para ser apresentador.',
    actor: 'attendee',
    enter: async () => {
      await att.waitAndClick(e.mediaAreaButton);
      await att.hasElement(e.requestPresenterButton, 'should offer to request the presenter role');
    },
    leave: () => att.waitAndClick(e.requestPresenterButton),
  });
  await rec.state(mod.page, {
    id: 'mod-presenter-request',
    name: 'Pedido de apresentador (moderador)',
    description: 'Pedido do participante para apresentar, com aprovar e recusar.',
    actor: 'moderator',
    enter: () => mod.hasElement(e.approvePresenter, 'should show the presenter request', ELEMENT_WAIT_LONGER_TIME),
    leave: () => mod.waitAndClick(e.denyPresenter),
  });
}

/** The moderator removes the attendee: the confirmation, the attendee's screen and what the moderator hears. */
async function auditAttendeeRemoved(rec: AuditRecorder, mod: Page, att: Page) {
  await rec.state(mod.page, {
    id: 'remove-user-confirm',
    name: 'Confirmar remoção (moderador)',
    description: 'Modal de confirmação para remover um participante da sala.',
    actor: 'moderator',
    enter: async () => {
      await openUserList(mod);
      await mod.page.locator(e.otherUserMoreOptionsButton).first().click();
      // Every row renders its own copy of the menu; only the open one is visible.
      await mod.page.locator(`${e.removeUser}:visible`).first().click();
      await mod.hasElement(e.removeUserConfirmationBtn, 'should ask to confirm the removal');
    },
  });
  await clearAnnouncements(mod.page);
  await rec.state(att.page, {
    id: 'attendee-removed',
    name: 'Removido da sala (participante)',
    description: 'Tela mostrada ao participante que foi removido pelo moderador.',
    actor: 'attendee',
    enter: async () => {
      await mod.waitAndClick(e.removeUserConfirmationBtn);
      await att.hasElement(e.meetingEndedModal, 'should tell the attendee they were removed', ELEMENT_WAIT_LONGER_TIME);
    },
  });
  await mod.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
  await rec.collectAnnouncements(mod.page, 'moderador: participante removido da sala');
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

test.describe('WCAG audit', { tag: '@a11y-audit' }, () => {
  test('moderator: full tour of the meeting UI', async ({ browser, context, page }, testInfo) => {
    const scenario: ScenarioInfo = {
      id: 'moderator',
      name: 'Moderador sozinho na sala',
      description:
        'Um moderador entra numa reunião gravável, conecta o áudio e percorre todos os painéis, menus e modais disponíveis para ele: lista de usuários, chat e as ações de mensagem, todas as abas das configurações, enquete, breakout, notas, galeria de apps, layout, gravação, timer, reações, apresentação, vídeo externo, webcam, compartilhamento de tela, quadro branco e, por fim, encerra a reunião.',
      actors: ['moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      await installAnnouncementRecorder(context);
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, {
        testInfo,
        shouldCloseAudioModal: false,
        createParameter: RECORDED_MEETING,
        clientSettingsOverrides: CHAT_EMOJI_PICKER_ON,
      });
      await noteAuditedServer(rec, mod);

      await auditJoiningAudio(rec, mod);
      await standardChecks(rec, mod.page);
      await checkMeetingControls(rec, mod.page);
      await auditPeopleAndChat(rec, mod);
      await auditSettingsAndTools(rec, mod);
      await auditMediaAndSharing(rec, mod);
      await auditMeetingMenus(rec, mod);
      await rec.collectAnnouncements(mod.page, 'moderador');
      await auditMeetingEnded(rec, mod);
    });
  });

  test('interactions: moderator and attendee', async ({ browser, context, page }, testInfo) => {
    const scenario: ScenarioInfo = {
      id: 'interactions',
      name: 'Moderador e participante interagindo',
      description:
        'Duas pessoas na mesma sala. O participante entra, manda mensagens no chat (com o chat do moderador aberto e depois fechado), levanta a mão, responde uma enquete e recebe uma mensagem privada. Grava o que seria anunciado ao leitor de tela de cada um e audita as telas do participante.',
      actors: ['attendee', 'moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo, createParameter: CAMERA_REQUESTS_ALLOWED });
      const mod = users.modPage;
      await openPublicChat(mod);
      await clearAnnouncements(mod.page);
      rec.note('announcementsDiscarded', 'logs before the attendee joined are not kept');
      await users.initUserPage(context, { testInfo });
      const att = users.userPage;
      await att.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(mod.page, 'moderador: participante entrou na sala');

      // What an attendee sees
      await rec.state(att.page, {
        id: 'attendee-meeting',
        name: 'Sala (participante)',
        description: 'Visão do participante comum, sem permissões de moderador.',
        actor: 'attendee',
      });
      await rec.state(att.page, {
        id: 'attendee-user-list',
        name: 'Lista de usuários (participante)',
        description: 'Painel de participantes visto por um participante.',
        actor: 'attendee',
        enter: () => openUserList(att),
      });
      await rec.state(att.page, {
        id: 'attendee-actions',
        name: 'Opções (participante)',
        description: 'Menu de opções do participante.',
        actor: 'attendee',
        ...opensWith(att, e.optionsButton),
      });

      // Chat messages, with the moderator's chat open and then closed
      await openPublicChat(att);
      await clearAnnouncements(mod.page);
      await sendChatMessages(att, ['Olá, tudo bem?', 'Alguém me ouve?', 'Vou compartilhar uma dúvida']);
      await mod.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(mod.page, 'moderador: 3 mensagens no chat público com o chat aberto');

      await mod.waitAndClick(e.hidePublicChat);
      await clearAnnouncements(mod.page);
      await sendChatMessages(att, ['Mensagem com o chat fechado', 'Outra mensagem']);
      await mod.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(mod.page, 'moderador: 2 mensagens com o chat fechado');
      await rec.state(mod.page, {
        id: 'mod-unread-chat',
        name: 'Chat não lido (moderador)',
        description: 'Moderador com mensagens não lidas e o chat fechado.',
        actor: 'moderator',
      });

      // Raised hand
      await att.waitAndClick(e.raiseHandBtn);
      await mod.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(mod.page, 'moderador: participante levantou a mão');
      await rec.state(mod.page, {
        id: 'mod-raised-hand',
        name: 'Mão levantada (moderador vê)',
        description: 'Lista de usuários do moderador com um participante de mão levantada.',
        actor: 'moderator',
        enter: () => openUserList(mod),
      });

      // Poll, from both sides
      await clearAnnouncements(att.page);
      await startPoll(mod);
      await rec.state(att.page, {
        id: 'attendee-poll',
        name: 'Responder enquete (participante)',
        description: 'Modal de resposta à enquete na tela do participante.',
        actor: 'attendee',
        enter: () => att.hasElement(e.pollingContainer, 'attendee should see the poll'),
      });
      await rec.collectAnnouncements(att.page, 'participante: enquete iniciada');
      await answerPollOption(att, 'A');
      await mod.page.waitForTimeout(1500);
      await rec.state(mod.page, {
        id: 'mod-poll-results',
        name: 'Resultados da enquete (moderador)',
        description: 'Painel do moderador com uma resposta recebida.',
        actor: 'moderator',
      });
      await mod.waitAndClick(e.publishPollingLabel).catch(() => undefined);
      await att.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(att.page, 'participante: resultado da enquete publicado');

      // Private message
      await clearAnnouncements(att.page);
      try {
        await openUserList(mod);
        await mod.page.locator(e.userListItem).filter({ hasText: 'Attendee' }).first().click();
        await mod.waitAndClick(e.startPrivateChat);
        await sendChatMessage(mod, 'Mensagem privada para o participante');
        await att.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
        await rec.collectAnnouncements(att.page, 'participante: recebeu mensagem privada');
        await rec.state(att.page, {
          id: 'attendee-private-message',
          name: 'Mensagem privada recebida (participante)',
          description: 'Tela do participante após receber uma mensagem privada.',
          actor: 'attendee',
        });
        await rec.state(mod.page, {
          id: 'mod-private-chat',
          name: 'Chat privado (moderador)',
          description: 'Conversa privada aberta do lado do moderador.',
          actor: 'moderator',
        });
      } catch (err) {
        rec.note('privateChatError', String(err).slice(0, 300));
      }

      await auditModeratingAttendee(rec, mod, att);
      await auditPresenterRequest(rec, mod, att);
      await auditAttendeeRemoved(rec, mod, att);
    });
  });

  test('breakout: rooms running', async ({ browser, context, page }, testInfo) => {
    skipUnlessTopic('4.1', '2.2', '1.3', '1.4', '2.1', '2.4', '3.2');
    const scenario: ScenarioInfo = {
      id: 'breakout',
      name: 'Salas de grupo em andamento',
      description:
        'O moderador cria uma sala de grupo com um participante. Audita o convite, a sala por dentro e o painel do moderador, e grava o que é anunciado durante 30 segundos sem interação (a contagem regressiva do tempo restante).',
      actors: ['attendee', 'moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo });
      await users.initUserPage(context, { testInfo });
      const mod = users.modPage;
      const att = users.userPage;

      // The creation panel needs a wide viewport to show the start button.
      await mod.setHeightWidthViewPortSize({ width: 1920, height: 1080 });
      await mod.waitAndClick(e.breakoutRoomSidebarButton);
      await mod.waitForSelector(e.attendeeNotAssigned, ELEMENT_WAIT_EXTRA_LONG_TIME);
      await mod.dragDropSelector(e.attendeeNotAssigned, e.breakoutBox1);
      await mod.waitAndClick(e.createBreakoutRoomsButton, ELEMENT_WAIT_LONGER_TIME);
      await mod.setHeightWidthViewPortSize();

      await rec.state(att.page, {
        id: 'attendee-invite',
        name: 'Convite para a sala (participante)',
        description: 'Modal que convida o participante a entrar na sala de grupo.',
        actor: 'attendee',
        enter: () => att.hasElement(e.modalConfirmButton, 'attendee should be invited'),
      });
      const roomTab = context.waitForEvent('page', { timeout: ELEMENT_WAIT_EXTRA_LONG_TIME }).catch(() => null);
      await att.waitAndClick(e.modalConfirmButton);
      const room = (await roomTab) || att.page;
      await room.waitForLoadState('domcontentloaded');
      // The room is a whole new client loading in a tab: on a remote server it takes well over the
      // usual wait. It opens on its audio modal, or straight on the meeting (the actions bar renders
      // with or without a presentation). The audio modal is closed so the room itself gets audited.
      const audioModal = `${e.audioModal}:visible, ${e.audioSettingsModal}:visible`;
      await room
        .locator(`${audioModal}, ${e.actionsBarBackground}:visible`)
        .first()
        .waitFor({ timeout: ROOM_LOAD_TIMEOUT });
      if (await room.locator(audioModal).count()) await room.locator(e.closeModal).first().click();
      await rec.state(room, {
        id: 'attendee-in-room',
        name: 'Dentro da sala de grupo (participante)',
        description: 'Cliente da sala de grupo, com o tempo restante.',
        actor: 'attendee',
      });
      await rec.state(mod.page, {
        id: 'mod-rooms-running',
        name: 'Salas em andamento (moderador)',
        description: 'Painel do moderador com a sala de grupo rodando.',
        actor: 'moderator',
        enter: () => mod.hasElement(e.roomOptions1, 'rooms should be running'),
      });
      await rec.state(mod.page, {
        id: 'mod-room-menu',
        name: 'Opções de uma sala (moderador)',
        description: 'Menu de uma sala de grupo em andamento (entrar, mandar mensagem, encerrar).',
        actor: 'moderator',
        ...opensWith(mod, e.roomOptions1),
      });

      // Idle period: is the countdown announced, and how often?
      rec.note('recorderAlreadyInstalled', {
        room: await ensureAnnouncementRecorder(room),
        moderator: await ensureAnnouncementRecorder(mod.page),
      });
      await clearAnnouncements(room);
      await clearAnnouncements(mod.page);
      // Independent evidence: the countdown text itself, before and after the idle period.
      const timeRemaining = (tab: PlaywrightPage) =>
        tab
          .locator(TIME_REMAINING)
          .first()
          .textContent({ timeout: 2000 })
          .catch(() => null);
      const before = { room: await timeRemaining(room), moderator: await timeRemaining(mod.page) };
      await room.waitForTimeout(BREAKOUT_IDLE_MS);
      rec.note('countdownText', {
        before,
        after: { room: await timeRemaining(room), moderator: await timeRemaining(mod.page) },
      });
      // Which live region (if any) contains the countdown: no region means it is never announced.
      const liveRegionAroundCountdown = (tab: PlaywrightPage) =>
        tab
          .evaluate(
            ({ countdown, liveRegion }) => {
              const el = document.querySelector(countdown);
              if (!el) return 'countdown not on screen';
              const region = el.closest(liveRegion);
              return region ? region.outerHTML.slice(0, 200) : 'no live region around the countdown';
            },
            { countdown: TIME_REMAINING, liveRegion: LIVE_REGION },
          )
          .catch((err) => String(err).slice(0, 100));
      rec.note('countdownLiveRegion', {
        room: await liveRegionAroundCountdown(room),
        moderator: await liveRegionAroundCountdown(mod.page),
      });
      await rec.collectAnnouncements(room, 'participante na sala de grupo: 30 s sem interagir');
      await rec.collectAnnouncements(mod.page, 'moderador na sala principal: 30 s sem interagir');
      rec.note('idleSeconds', BREAKOUT_IDLE_MS / 1000);
    });
  });

  test('guest: waiting lobby and approval', async ({ browser, context, page }, testInfo) => {
    const scenario: ScenarioInfo = {
      id: 'guest',
      name: 'Convidado na sala de espera',
      description:
        'Reunião com aprovação de convidados (guestPolicy=ASK_MODERATOR). Um convidado entra e fica na sala de espera; o moderador vê o pedido, manda uma mensagem para a sala de espera e aprova. Audita as telas dos dois e grava os anúncios.',
      actors: ['guest', 'moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo, createParameter: 'guestPolicy=ASK_MODERATOR' });
      const mod = users.modPage;
      await clearAnnouncements(mod.page);
      await users.initUserPage2(context, {
        fullName: 'Convidado',
        joinParameter: 'guest=true',
        shouldCloseAudioModal: false,
        shouldCheckAllInitialSteps: false,
        testInfo,
      });
      const guest = users.userPage2;

      await rec.state(guest.page, {
        id: 'guest-lobby',
        name: 'Sala de espera (convidado)',
        description: 'Tela de espera do convidado aguardando aprovação.',
        actor: 'guest',
        enter: () => guest.hasElement(e.guestMessage, 'guest should wait'),
      });
      await rec.check('guest-lobby-keyboard', () => checkKeyboard(guest.page, 30), ['2.1', '2.4']);
      await rec.check('guest-lobby-reflow', () => checkReflow(guest.page), ['1.4']);
      await mod.page.waitForTimeout(1500);
      await rec.collectAnnouncements(mod.page, 'moderador: convidado aguardando aprovação');

      await rec.state(mod.page, {
        id: 'mod-waiting-list',
        name: 'Pedidos de entrada (moderador)',
        description: 'Painel do moderador com o convidado aguardando.',
        actor: 'moderator',
        enter: async () => {
          await openUserList(mod);
          await mod.waitAndClick(e.guestWaitingUsers);
          await mod.hasElement(e.waitingUserName, 'should list the waiting guest');
        },
      });

      await clearAnnouncements(guest.page);
      try {
        await mod.page.locator(e.waitingUserName).first().hover();
        await mod.waitAndClick(PRIVATE_MESSAGE_GUEST);
        await mod.page.locator(PRIVATE_LOBBY_MESSAGE).fill('Aguarde um momento, já vamos liberar');
        await mod.page.keyboard.press('Enter');
        await guest.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
        await rec.collectAnnouncements(guest.page, 'convidado: recebeu mensagem do moderador na sala de espera');
        await rec.state(guest.page, {
          id: 'guest-lobby-message',
          name: 'Mensagem na sala de espera (convidado)',
          description: 'Sala de espera após o moderador enviar uma mensagem.',
          actor: 'guest',
        });
      } catch (err) {
        rec.note('lobbyMessageError', String(err).slice(0, 300));
      }

      await pressEscape(mod.page);
      await mod.page.locator(e.waitingUserName).first().hover();
      await mod.waitAndClick(ACCEPT_GUEST);
      await rec.state(guest.page, {
        id: 'guest-admitted',
        name: 'Convidado aprovado',
        description: 'Primeira tela do convidado depois de ser aprovado.',
        actor: 'guest',
        enter: () => guest.hasElement(e.audioModal, 'guest should reach the audio modal'),
      });
      await rec.collectAnnouncements(guest.page, 'convidado: aprovado e entrou');
    });
  });

  test('pre-flight: setup screen before joining', async ({ browser, context, page }, testInfo) => {
    const scenario: ScenarioInfo = {
      id: 'pre-flight',
      name: 'Tela de entrada (pre-flight)',
      description:
        'Tela da 4.1 que aparece antes de entrar na sala (ligada por sessão com o pre-flight): dados da sessão, áudio, câmera e configurações. Também a tela de permissão quando o navegador recusa o microfone, e a sala de espera e a recusa de um participante que precisa de aprovação.',
      actors: ['attendee', 'moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo, createParameter: PRE_FLIGHT_CREATE_PARAMETER });
      const mod = users.modPage;

      /** Opens a new tab that joins as an attendee and stops on the pre-flight screen. */
      const openPreFlight = async (fullName: string, prepare?: (tab: PlaywrightPage) => Promise<unknown>) => {
        const tab = await context.newPage();
        if (prepare) await prepare(tab);
        const user = new Page(browser, tab, testInfo);
        await user.init(false, { fullName, meetingId: mod.meetingId, ...PRE_FLIGHT_INIT_OPTIONS });
        await user.hasElement(e.preFlight, 'should display the pre-flight screen', ELEMENT_WAIT_EXTRA_LONG_TIME);
        return user;
      };

      const att = await openPreFlight('Attendee');
      await rec.state(att.page, {
        id: 'pre-flight',
        name: 'Tela de entrada',
        description: 'Antes de entrar: nome da sessão, microfone, alto-falante, câmera e botão de entrar.',
      });
      await standardChecks(rec, att.page, 'pre-flight-');
      await rec.state(att.page, {
        id: 'pre-flight-settings',
        name: 'Configurações antes de entrar',
        description: 'Modal de configurações (idioma, tamanho da fonte, tema) aberto na tela de entrada.',
        ...opensWith(att, e.preFlightSettingsButton),
      });
      await rec.state(att.page, {
        id: 'pre-flight-camera-on',
        name: 'Câmera ligada antes de entrar',
        description: 'Tela de entrada com a câmera ligada, a prévia e os seletores de câmera e qualidade.',
        enter: async () => {
          await att.waitAndClick(e.preFlightCameraToggle);
          await att.hasElement(e.preFlightCameraDevice, 'should show the camera selector', ELEMENT_WAIT_LONGER_TIME);
        },
        leave: () => att.waitAndClick(e.preFlightCameraToggle),
      });
      await att.page.close();

      const refused = await openPreFlight('Attendee 2', (tab) =>
        tab.addInitScript(refuseDevices, { audio: true, video: false }),
      );
      await rec.state(refused.page, {
        id: 'pre-flight-device-permission',
        name: 'Microfone bloqueado pelo navegador',
        description: 'Tela de entrada quando o navegador recusa o acesso ao microfone.',
        enter: () =>
          refused.hasElement(
            e.preFlightDevicePermission,
            'should explain the refused device',
            ELEMENT_WAIT_LONGER_TIME,
          ),
      });
      await refused.page.close();

      await setGuestPolicyOption(mod, e.askModerator);
      await mod.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS); // the policy has to reach the server first
      const waiting = await openPreFlight('Attendee 3');
      await rec.state(waiting.page, {
        id: 'pre-flight-guest-lobby',
        name: 'Aguardando aprovação na tela de entrada',
        description: 'Tela de entrada enquanto o moderador ainda não aprovou a entrada.',
        enter: () => waiting.hasElement(e.guestMessage, 'should say the attendee is waiting'),
      });
      await rec.collectAnnouncements(waiting.page, 'participante aguardando aprovação na tela de entrada');
      await rec.state(waiting.page, {
        id: 'pre-flight-guest-denied',
        name: 'Entrada recusada',
        description: 'Tela de entrada depois que o moderador recusa a entrada.',
        enter: async () => {
          await mod.waitAndClick(e.authenticatedWaitingUsers);
          await mod.waitAndClick(e.denyAllAuthenticatedWaiting);
          await waiting.hasElement(e.preFlightGuestDenied, 'should show the denial', ELEMENT_WAIT_LONGER_TIME);
        },
      });
      await waiting.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(waiting.page, 'participante: entrada recusada');
    });
  });

  test('connection: lost and reconnecting', async ({ browser, page }, testInfo) => {
    skipUnlessTopic('4.1', '1.3', '1.4', '2.2', '3.3');
    const scenario: ScenarioInfo = {
      id: 'connection',
      name: 'Conexão perdida',
      description:
        'A conexão com o servidor cai (derrubada pelo próprio navegador) e o cliente tenta reconectar. Audita o aviso de reconexão, o que fica desabilitado e o que é anunciado ao leitor de tela.',
      actors: ['moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      const connection = await routeServerConnection(page);
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, clientSettingsOverrides: SHOW_RECONNECTING_TOAST });
      await ensureAnnouncementRecorder(page);
      await openPublicChat(mod);
      await clearAnnouncements(page);
      await rec.state(page, {
        id: 'reconnecting',
        name: 'Reconectando',
        description: 'Sala logo depois de a conexão cair, com o aviso de reconexão em andamento.',
        enter: async () => {
          connection.drop();
          await mod.hasElement(e.reconnectingToast, 'should say it is reconnecting');
        },
      });
      await rec.collectAnnouncements(page, 'moderador: conexão caiu');
      await mod.wasRemoved(e.reconnectingToast, 'should reconnect', ELEMENT_WAIT_EXTRA_LONG_TIME * 2);
      await page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(page, 'moderador: conexão restabelecida');
    });
  });

  test('variant: Brazilian Portuguese locale', async ({ browser, page }, testInfo) => {
    skipUnlessTopic('1.4', '3.1', '2.5');
    const scenario: ScenarioInfo = {
      id: 'locale-pt-br',
      name: 'Idioma português (pt-BR)',
      description:
        'Mesma sala com o idioma do cliente em pt-BR. Confere o atributo lang da página e se textos mais longos que em inglês quebram o layout ou são cortados.',
      actors: ['variant'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, joinParameter: 'userdata-bbb_override_default_locale=pt-BR' });
      await rec.state(page, {
        id: 'meeting',
        name: 'Sala em pt-BR',
        description: 'Estado principal com o cliente em português.',
      });
      await rec.check('textSpacing', () => checkTextSpacing(page), ['1.4']);
      await rec.check('reflow', () => checkReflow(page), ['1.4']);
      await rec.state(page, {
        id: 'public-chat',
        name: 'Chat em pt-BR',
        description: 'Chat público em português.',
        enter: () => openPublicChat(mod),
      });
      await rec.state(page, {
        id: 'settings',
        name: 'Configurações em pt-BR',
        description: 'Modal de configurações em português.',
        enter: () => mod.waitAndClick(e.settingsSidebarButton),
        leave: () => mod.waitAndClick(e.saveSettingsButton),
      });
      await rec.state(page, {
        id: 'options-menu',
        name: 'Menu de opções em pt-BR',
        description: 'Menu geral em português.',
        ...opensWith(mod, e.optionsButton),
      });
    });
  });

  test('variant: dark theme', async ({ browser, page }, testInfo) => {
    skipUnlessTopic('1.4');
    const scenario: ScenarioInfo = {
      id: 'dark-theme',
      name: 'Tema escuro',
      description:
        'Mesma sala com o modo escuro ligado nas configurações. Foco em contraste de texto e de componentes.',
      actors: ['variant'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo });
      try {
        await mod.waitAndClick(e.settingsSidebarButton);
        await mod.waitAndClick(e.darkModeToggleBtn);
        await mod.waitAndClick(e.saveSettingsButton);
        await page.waitForTimeout(1500);
        const darkReaderActive = await page.evaluate(() => document.querySelectorAll('style.darkreader').length > 0);
        rec.note('darkModeEnabled', darkReaderActive);
      } catch (err) {
        rec.note('darkModeError', String(err).slice(0, 300));
      }
      await rec.state(page, {
        id: 'meeting',
        name: 'Sala no tema escuro',
        description: 'Estado principal com o tema escuro.',
      });
      await rec.check('nonTextContrast', () => findNonTextContrastViolations(page), ['1.4']);
      await rec.state(page, {
        id: 'public-chat',
        name: 'Chat no tema escuro',
        description: 'Chat público no tema escuro.',
        enter: () => openPublicChat(mod),
      });
      await rec.state(page, {
        id: 'user-list',
        name: 'Lista de usuários no tema escuro',
        description: 'Painel de participantes no tema escuro.',
        enter: () => openUserList(mod),
      });
      await rec.state(page, {
        id: 'settings',
        name: 'Configurações no tema escuro',
        description: 'Modal de configurações no tema escuro.',
        ...opensWith(mod, e.settingsSidebarButton),
      });
    });
  });

  test('variant: mobile phone', async ({ browser }, testInfo) => {
    skipUnlessTopic('1.1', '1.3', '1.4', '2.5', '4.1');
    const scenario: ScenarioInfo = {
      id: 'mobile',
      name: 'Celular (emulado)',
      description:
        'Cliente aberto num celular Android emulado (Pixel 7, toque, user agent móvel), em retrato e paisagem. Não substitui um aparelho real, mas mostra o layout móvel, alvos de toque e orientação.',
      actors: ['variant'],
    };
    const phone = await browser.newContext({ ...devices['Pixel 7'] });
    await auditScenario(testInfo, scenario, async (rec) => {
      const page = await phone.newPage();
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, shouldCloseAudioModal: false });
      await rec.state(page, {
        id: 'audio-modal',
        name: 'Modal de áudio no celular',
        description: 'Escolha de áudio no layout móvel.',
        enter: () => mod.hasElement(e.audioModal, 'audio modal'),
      });
      await rec.state(page, {
        id: 'meeting-portrait',
        name: 'Sala no celular (retrato)',
        description: 'Estado principal no layout móvel em retrato.',
        enter: async () => {
          if (await mod.checkElement(e.audioModal)) await mod.closeAudioModal();
        },
      });
      await rec.state(page, {
        id: 'public-chat',
        name: 'Chat no celular',
        description: 'Chat público no layout móvel.',
        enter: () => openPublicChat(mod),
        leave: () => mod.waitAndClick(e.hidePublicChat),
      });
      await rec.state(page, {
        id: 'options-menu',
        name: 'Menu de opções no celular',
        description: 'Menu geral no layout móvel.',
        ...opensWith(mod, e.optionsButton),
      });
      await rec.state(page, {
        id: 'meeting-landscape',
        name: 'Sala no celular (paisagem)',
        description: 'Mesmo aparelho girado para paisagem.',
        enter: async () => {
          const size = page.viewportSize();
          if (size) await page.setViewportSize({ width: size.height, height: size.width });
          await page.waitForTimeout(1500);
        },
      });
    });
    await phone.close();
  });
});
