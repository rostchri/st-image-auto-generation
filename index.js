/**
 * SillyTavern Image Auto Generation Extension
 *
 * This extension automatically generates images when it detects <pic prompt="..."> tags in AI messages.
 * It injects a prompt instruction into the chat completion to encourage the AI to include image tags,
 * then processes incoming messages to detect these tags and trigger image generation.
 */

// Import extension settings and context management
import { extension_settings, getContext } from '../../../extensions.js';

// Import core SillyTavern functions
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    getRequestHeaders,
} from '../../../../script.js';
import { appendMediaToMessage } from '../../../../script.js';
import { regexFromString, saveBase64AsFile } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

// Import regex engine functions to apply regex transformations before searching for tags
// This is necessary because SillyTavern applies regex transformations to messages,
// and we need to search in the transformed message, not the raw one
import { getRegexedString, regex_placement } from '../../../extensions/regex/engine.js';

// Extension name and folder path
const extensionName = 'st-image-auto-generation';
// Path to the extension folder: /scripts/extensions/third-party/st-image-auto-generation
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

/**
 * Global set to track processed messages and prevent infinite loops
 * Uses messageIndex to uniquely identify messages that have already been processed
 * This prevents re-processing messages even if events are triggered multiple times
 */
const processedMessages = new Set();

/**
 * Image insertion type constants
 * - DISABLED: Extension is disabled, no image generation
 * - INLINE: Insert images into the message's extra array (supports image controls)
 * - NEW_MESSAGE: Create new messages with generated images (default ST method, best compatibility)
 * - REPLACE: Remove the <pic> tag from the message text and add image to message.extra (uses SillyTavern's image viewer with zoom, prompt display, and seed regeneration)
 */
const INSERT_TYPE = {
    DISABLED: 'disabled',
    INLINE: 'inline',
    NEW_MESSAGE: 'new',
    REPLACE: 'replace',
};

/**
 * Escapes characters for safe inclusion inside HTML attribute values.
 * Prevents XSS attacks by escaping special HTML characters.
 *
 * @param {string} value - The string to escape
 * @returns {string} - The escaped string, or empty string if input is not a string
 */
function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Escapes special regex characters in a string so it can be safely used in a RegExp constructor.
 * This is needed when searching for literal strings that may contain regex special characters.
 *
 * @param {string} str - The string to escape
 * @returns {string} - The escaped string safe for use in RegExp
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generiert ein Bild ueber die self-hosted ComfyUI backend (st-comfyui-workflows extension).
 *
 * Geht jetzt ueber den SillyTavern-Backend-Proxy (st-ext-server-loader →
 * st-comfyui-workflows/server). Der Browser fetcht same-origin gegen
 * `/api/plugins/st-ext-server-loader/ext/st-comfyui-workflows/workflow/<name>`.
 * Das ST-Backend macht dann den eigentlichen HTTP-Call zu comfyui-api
 * ueber ein internes Netz (Tailscale, Docker-Bridge, etc.). Vorteile:
 *
 *   - Kein CORS / keine Cookie-Magie
 *   - Zentrales Log im ST-Container
 *   - comfyui-api muss nicht ueber TLS / Authelia erreichbar sein
 *
 * Setup-Voraussetzungen (einmalig pro ST-Instanz):
 *   1. `st-ext-server-loader` als ST-Plugin installiert
 *   2. `SILLYTAVERN_ENABLESERVERPLUGINS=true` und `COMFYUI_BASE_URL` env-vars
 *   3. `st-comfyui-workflows`-Extension installiert (liefert das server/
 *      Verzeichnis, das vom Loader gepickt wird)
 *
 * Der Workflow + die per-Workflow-Parameter werden weiter aus
 * `extension_settings.comfyui_workflows.{workflow, params}` gelesen — der
 * <pic>-Prompt ueberschreibt nur das `prompt`-Feld.
 *
 * Returns: URL als String bei Erfolg (ueber saveBase64AsFile auf Disk
 * gespeichert; analog zum NanoGPT-Pfad), data-URI als Fallback, leerer
 * String bei Fehler.
 */
async function generateViaComfyUiWorkflows(prompt) {
    const cfg = (extension_settings && extension_settings.comfyui_workflows) || {};
    const workflow = cfg.workflow || '';
    if (!workflow) {
        const msg = `[${extensionName}] kein Workflow ausgewaehlt — bitte in "ComfyUI Workflows"-Extension einen Workflow setzen.`;
        console.error(msg);
        try { toastr.error(msg); } catch (_) { /* toastr optional */ }
        return '';
    }
    // Per-Workflow saved params (width/height/seed/steps/cfg/sampler etc.) —
    // der <pic>-Prompt ueberschreibt nur `prompt`. input_image weglassen, das
    // ist ein per-Render-Wert aus dem Settings-Test (base64-Blob).
    const savedParams = (cfg.params && cfg.params[workflow]) || {};
    const input = { ...savedParams, prompt: String(prompt || '') };
    delete input.input_image;

    const url = `/api/plugins/st-ext-server-loader/ext/st-comfyui-workflows/workflow/${encodeURIComponent(workflow)}`;
    console.log(`[${extensionName}] ComfyUI Workflows (via ST backend) POST ${url}`, { input });
    try {
        // getRequestHeaders() setzt X-CSRF-Token + Content-Type — ST's
        // CSRF-Middleware blockt sonst /api/* POST mit 403 Forbidden.
        const r = await fetch(url, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ input }),
        });
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            console.error(`[${extensionName}] ComfyUI Workflows HTTP ${r.status} ${url} — ${text.slice(0, 200)}`);
            try { toastr.error(`ComfyUI Workflows HTTP ${r.status} — siehe Browser-Console`); } catch (_) {}
            return '';
        }
        const data = await r.json();
        if (!data.images || !data.images.length) {
            console.error(`[${extensionName}] ComfyUI Workflows response without images`, data);
            return '';
        }
        // Statt das base64 direkt als data:URI in die Chat-Message zu schreiben
        // (was chat.json um Megabytes pro Bild blaeht), speichert ST das Bild
        // serverseitig ueber saveBase64AsFile und gibt eine URL zurueck — analog
        // zum NanoGPT-Pfad in SillyTavern's eigener stable-diffusion extension.
        try {
            const context = getContext();
            const charName = context.characters?.[context.characterId]?.name || 'comfyui-workflows';
            const fileName = `${workflow}_${Date.now()}`;
            const url = await saveBase64AsFile(data.images[0], charName, fileName, 'png');
            return url;
        } catch (saveErr) {
            console.warn(`[${extensionName}] saveBase64AsFile failed, falling back to data-URI:`, saveErr);
            return `data:image/png;base64,${data.images[0]}`;
        }
    } catch (e) {
        console.error(`[${extensionName}] ComfyUI Workflows fetch fehlgeschlagen:`, e);
        return '';
    }
}

/**
 * Default extension settings
 * These are used when the extension is first loaded or when settings are missing
 */
const defaultSettings = {
    // Image insertion type — REPLACE strips the <pic> tag from the rendered
    // message and shows the generated image in its place (cleanest UX for
    // Roleplay-Setups). Combined with multi-viewer below, every tag gets its
    // own inline image at the position of the original tag.
    insertType: INSERT_TYPE.REPLACE,
    // Whether to process user messages for <pic> tags
    // Enabled by default: useful for Quick Replies / manual user input that
    // include <pic> tags.
    processUserMessages: true,
    // Whether to apply SillyTavern regex transformations before searching for <pic> tags
    // Enabled by default: SillyTavern's regex engine often hides/transforms
    // <pic> tags before display — running our search through the same pipeline
    // ensures we still find the tags.
    applyRegexTransformations: true,
    // Whether to use SillyTavern's image viewer in REPLACE mode
    // Disabled by default: simple <img>-tag rendering pairs better with the
    // multi-viewer setting below (each tag = own inline viewer). Enable this
    // only when you want a single combined ST swipe-viewer instead.
    replaceModeUseImageViewer: false,
    // Whether to use multiple separate image viewers (one per <pic> tag)
    // Enabled by default: each tag becomes its own inline image at the exact
    // position in the message text — readable, scrollable, multi-image friendly.
    useMultipleImageViews: true,
    // Whether to process <pic> tags when messages are edited (enabled by default)
    // When enabled, adding <pic> tags to existing messages via edit will trigger image generation
    processEditedMessages: true,
    // Maximum number of times images can be generated for a single message.
    // Default 3: allows up to 3 distinct <pic> tags per AI turn before the
    // loop guard kicks in — sweet spot for most roleplay scenes (intro shot,
    // detail shot, environment shot) without runaway generation.
    maxImageGenerationsPerMessage: 3,
    // Prompt injection configuration
    promptInjection: {
        // Whether prompt injection is enabled
        enabled: true,
        // The prompt template that will be injected into the chat completion
        // This instructs the AI to include <pic> tags in its responses.
        //
        // Format rules embedded in the prompt:
        //   - DOUBLE quotes for the attribute: prompt="..."
        //   - SINGLE quotes inside the JSON value (no nested double quotes!)
        //   - One <pic> tag per image — separate tags for separate scenes
        //
        // Why this matters: the default regex below matches the prompt value
        // as `[^"]+`, i.e. up to the next double-quote. If the JSON inside
        // contains a stray `"`, the attribute closes too early. Keeping the
        // outer attribute double-quoted and the JSON single-quoted avoids
        // any conflict and lets multiple <pic> tags be matched independently.
        prompt: `<image_generation>
Insert one or more <pic prompt="..."> tags in your reply. Each tag triggers ONE Stable-Diffusion image. For multiple distinct visual moments, use SEPARATE tags — never combine multiple scenes into one prompt.

Format rules:
- Wrap the prompt in DOUBLE quotes: prompt="..."
- Use SINGLE quotes inside the JSON value (no nested double quotes!)
- Self-closing or open form both work: <pic prompt="..."> or <pic prompt="..." />

JSON schema for the prompt value:
{
  'perspective': 'string',          // POV / camera setup
  'subject': 'string',              // Dense description of primary subject(s) and action, frame-centered
  'environment': 'string',          // Surroundings, setting, background
  'mood': 'string',                 // Lighting, color palette, atmosphere, weather
  'camera': 'string',               // DOF, shot angle, lens, framing
  'style': 'string',                // Art direction. Anime if subject(s) clearly non-human
  'characters': [                   // Every character visible in frame
    {
      'name': 'string',
      'features': 'string',         // Age, ethnicity, face, hair — dense comma-separated
      'body_features': 'string',    // Sizes/shapes as 'thighs: soft, tan. breasts: small, triangle.'
      'attire': 'string',           // Clothing/accessories with colors
      'action': 'string'            // Limb positions, joint angles, distance in cm/m
    }
  ]
}

Perspective guidance:
- Default: first-person POV from the user, aimed at the visually central character/body part.
- For additional tags in the same reply: feel free to reverse perspective for variety.

Example (single tag — keep all values inside ONE pair of double quotes):
<pic prompt="{'perspective': 'first person', 'subject': 'Riley standing chest-deep in pool, purple bikini, eye contact, gentle smile', 'environment': 'private villa pool, golden-hour reflections', 'mood': 'warm low sun, calm intimate atmosphere', 'camera': 'POV at waterline, slight low angle ~10deg, medium shot, 35mm f/2.0 shallow DOF', 'style': 'photorealistic cinematic, natural golden hour, soft bokeh, no text', 'characters': [{'name': 'Riley Prescott', 'features': '19yo, hazel eyes with green/gold shimmer, long damp dark hair, lightly tanned, sincere expression', 'body_features': 'height 190cm, athletic muscular, broad shoulders, defined arms, visible six-pack', 'attire': 'purple tank-top bikini, fitted top with wide straps, high-cut bottoms', 'action': 'distance 1.2m, upright, water at mid-sternum, head forward slight 5deg right tilt, both forearms resting on water surface, hands relaxed open 15cm apart, gentle sincere smile'}]}">
</image_generation>`,
        // Regular expression to match <pic> tags in AI messages.
        //
        // Capture group 1 = the JSON prompt value (everything between the two
        // double quotes of the prompt= attribute).
        //
        // Why this exact pattern:
        //   <pic           — literal opener
        //   \s+            — at least one whitespace (forbids "<pict" / "<picnic" matches)
        //   prompt="       — literal attribute name + opening double quote
        //   ([^"]+)        — capture group 1: one or more non-double-quote chars
        //                    Bounded by the next " — won't span tags as long as the
        //                    JSON inside uses single quotes. Matches each <pic>
        //                    tag independently in a multi-tag message.
        //   "              — literal closing double quote of attribute
        //   \s*\/?>        — optional whitespace + optional self-close + closing >
        //   /g             — global, collect all matches via matchAll
        //
        // The previous default `/<pic[^>]*\sprompt="([^"]*)"[^>]*?>/g` had a
        // greedy `[^>]*` opener that interacted poorly with templates where the
        // attribute used single quotes outside (allowing the engine to span
        // multiple tags into a single match). The simpler pattern below avoids
        // that class of pitfalls entirely.
        regex: '/<pic\\s+prompt="([^"]+)"\\s*\\/?>/g',
        // Position where the prompt should be injected: deep_system, deep_user, or deep_assistant
        position: 'deep_system',
        // Depth: 0 means add to the end, >0 means insert from the end at the specified position
        depth: 0,
    },
    // ComfyUI Workflows renderer — optional fallback that bypasses ST's `/sd`
    // slash-command and posts directly to a self-hosted comfyui-api endpoint.
    //
    // Konfiguration (base_url, workflow) wird aus der `st-comfyui-workflows`-
    // Extension uebernommen (`extension_settings.comfyui_workflows`). Hier nur
    // der Enable-Toggle damit zwei Stellen NICHT parallel gepflegt werden
    // muessen.
    //
    // enabled: when true, every <pic>-tag generation geht durch unsere
    // generateViaComfyUiWorkflows() statt durch ST's /sd-Slash-Command.
    // Default false — vanilla-Setups unangetastet.
    comfyui_wf: {
        enabled: false,
    },
};

/**
 * Updates the UI based on current extension settings
 * Synchronizes the extension menu button state and settings form fields with the stored settings
 */
function updateUI() {
    // Update the extension menu button state based on insertType
    // The button appears selected when the extension is enabled
    $('#auto_generation').toggleClass(
        'selected',
        extension_settings[extensionName].insertType !== INSERT_TYPE.DISABLED,
    );

    // Only update form elements if they exist (settings panel may not be loaded yet)
    if ($('#image_generation_insert_type').length) {
        $('#image_generation_insert_type').val(
            extension_settings[extensionName].insertType,
        );
        $('#prompt_injection_enabled').prop(
            'checked',
            extension_settings[extensionName].promptInjection.enabled,
        );
        $('#prompt_injection_text').val(
            extension_settings[extensionName].promptInjection.prompt,
        );
        $('#prompt_injection_regex').val(
            extension_settings[extensionName].promptInjection.regex,
        );
        $('#prompt_injection_position').val(
            extension_settings[extensionName].promptInjection.position,
        );
        $('#prompt_injection_depth').val(
            extension_settings[extensionName].promptInjection.depth,
        );
        $('#process_user_messages').prop(
            'checked',
            extension_settings[extensionName].processUserMessages || false,
        );
        $('#apply_regex_transformations').prop(
            'checked',
            extension_settings[extensionName].applyRegexTransformations || false,
        );
        $('#replace_mode_use_image_viewer').prop(
            'checked',
            extension_settings[extensionName].replaceModeUseImageViewer !== false, // Default to true
        );
        $('#use_multiple_image_views').prop(
            'checked',
            extension_settings[extensionName].useMultipleImageViews || false, // Default to false
        );
        $('#process_edited_messages').prop(
            'checked',
            extension_settings[extensionName].processEditedMessages !== false, // Default to true
        );
        $('#max_image_generations_per_message').val(
            extension_settings[extensionName].maxImageGenerationsPerMessage || 1, // Default to 1
        );
        // ComfyUI Workflows block — nur der Toggle. base_url + workflow kommen
        // aus extension_settings.comfyui_workflows (der `st-comfyui-workflows`-
        // Extension). Wir zeigen die aktuellen Werte read-only als Hint
        // damit der User sieht was greift.
        const cw = extension_settings[extensionName].comfyui_wf || {};
        $('#comfyui_wf_enabled').prop('checked', cw.enabled === true);
        const cfg = (extension_settings && extension_settings.comfyui_workflows) || {};
        const baseUrl = cfg.base_url || '(nicht gesetzt — bitte in der "ComfyUI Workflows"-Extension konfigurieren)';
        const workflow = cfg.workflow || '(nicht gesetzt)';
        $('#comfyui_wf_config_hint').text(`Base-URL: ${baseUrl}  ·  Workflow: ${workflow}`);
    }
}

/**
 * Loads and initializes extension settings
 * Ensures all required settings exist, using defaults for missing values
 * This handles migration from older versions and ensures backward compatibility
 */
async function loadSettings() {
    // Initialize extension settings object if it doesn't exist
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // If settings are empty or missing required properties, use default settings
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    } else {
        // Ensure promptInjection object exists
        if (!extension_settings[extensionName].promptInjection) {
            extension_settings[extensionName].promptInjection =
                defaultSettings.promptInjection;
        } else {
            // Ensure all promptInjection sub-properties exist
            // This handles cases where new settings were added in updates
            const defaultPromptInjection = defaultSettings.promptInjection;
            for (const key in defaultPromptInjection) {
                if (
                    extension_settings[extensionName].promptInjection[key] ===
                    undefined
                ) {
                    extension_settings[extensionName].promptInjection[key] =
                        defaultPromptInjection[key];
                }
            }
        }

        // Ensure insertType property exists
        if (extension_settings[extensionName].insertType === undefined) {
            extension_settings[extensionName].insertType =
                defaultSettings.insertType;
        }

        // Ensure processUserMessages property exists
        if (extension_settings[extensionName].processUserMessages === undefined) {
            extension_settings[extensionName].processUserMessages =
                defaultSettings.processUserMessages;
        }

        // Ensure applyRegexTransformations property exists
        if (extension_settings[extensionName].applyRegexTransformations === undefined) {
            extension_settings[extensionName].applyRegexTransformations =
                defaultSettings.applyRegexTransformations;
        }

        // Ensure replaceModeUseImageViewer property exists
        if (extension_settings[extensionName].replaceModeUseImageViewer === undefined) {
            extension_settings[extensionName].replaceModeUseImageViewer =
                defaultSettings.replaceModeUseImageViewer;
        }

        // Ensure useMultipleImageViews property exists
        if (extension_settings[extensionName].useMultipleImageViews === undefined) {
            extension_settings[extensionName].useMultipleImageViews =
                defaultSettings.useMultipleImageViews;
        }

        // Ensure processEditedMessages property exists
        if (extension_settings[extensionName].processEditedMessages === undefined) {
            extension_settings[extensionName].processEditedMessages =
                defaultSettings.processEditedMessages;
        }

        // Ensure maxImageGenerationsPerMessage property exists
        if (extension_settings[extensionName].maxImageGenerationsPerMessage === undefined) {
            extension_settings[extensionName].maxImageGenerationsPerMessage =
                defaultSettings.maxImageGenerationsPerMessage;
        }

        // Ensure comfyui_wf sub-object exists (jetzt nur noch `enabled`).
        // Migration: falls aus einer frueheren Version base_url/workflow
        // gespeichert sind — die sind harmlos, werden aber nicht mehr
        // ausgewertet (Source-of-Truth ist extension_settings.comfyui_workflows).
        if (!extension_settings[extensionName].comfyui_wf) {
            extension_settings[extensionName].comfyui_wf = { ...defaultSettings.comfyui_wf };
        } else if (extension_settings[extensionName].comfyui_wf.enabled === undefined) {
            extension_settings[extensionName].comfyui_wf.enabled = defaultSettings.comfyui_wf.enabled;
        }
    }

    // Update UI to reflect loaded settings
    updateUI();
}

/**
 * Creates and initializes the settings page
 * Sets up event handlers for all settings form fields
 *
 * @param {string} settingsHtml - The HTML content for the settings panel
 */
async function createSettings(settingsHtml) {
    // Create a container for the settings if it doesn't exist
    // This ensures the settings display correctly in the extension settings panel
    if (!$('#image_auto_generation_container').length) {
        $('#extensions_settings2').append(
            '<div id="image_auto_generation_container" class="extension_container"></div>',
        );
    }

    // Use the provided settingsHtml instead of fetching it again
    $('#image_auto_generation_container').empty().append(settingsHtml);

    // Add event handlers for settings changes
    // Image insertion type dropdown
    $('#image_generation_insert_type').on('change', function () {
        const newValue = $(this).val();
        extension_settings[extensionName].insertType = newValue;
        updateUI();
        saveSettingsDebounced();
    });

    // Prompt injection enabled checkbox
    $('#prompt_injection_enabled').on('change', function () {
        extension_settings[extensionName].promptInjection.enabled =
            $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Prompt injection text area
    $('#prompt_injection_text').on('input', function () {
        extension_settings[extensionName].promptInjection.prompt =
            $(this).val();
        saveSettingsDebounced();
    });

    // Prompt injection regex input
    $('#prompt_injection_regex').on('input', function () {
        extension_settings[extensionName].promptInjection.regex = $(this).val();
        saveSettingsDebounced();
    });

    // Prompt injection position dropdown
    $('#prompt_injection_position').on('change', function () {
        extension_settings[extensionName].promptInjection.position =
            $(this).val();
        saveSettingsDebounced();
    });

    // Prompt injection depth input
    // Depth determines where in the chat history the prompt is injected
    $('#prompt_injection_depth').on('input', function () {
        const value = parseInt(String($(this).val()));
        extension_settings[extensionName].promptInjection.depth = isNaN(value)
            ? 0
            : value;
        saveSettingsDebounced();
    });

    // Process user messages checkbox
    // When enabled, the extension will also process <pic> tags in user messages
    $('#process_user_messages').on('change', function () {
        extension_settings[extensionName].processUserMessages =
            $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Apply regex transformations checkbox
    // When enabled, SillyTavern regex transformations are applied before searching for <pic> tags
    $('#apply_regex_transformations').on('change', function () {
        extension_settings[extensionName].applyRegexTransformations =
            $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Replace mode use image viewer checkbox
    // When enabled, REPLACE mode uses SillyTavern's image viewer with zoom, prompt display, and seed regeneration
    // When disabled, REPLACE mode uses simple <img> tags
    $('#replace_mode_use_image_viewer').on('change', function () {
        extension_settings[extensionName].replaceModeUseImageViewer =
            $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Use multiple image views checkbox
    // When enabled, each <pic> tag gets its own separate image viewer at that position
    // When disabled, all images are collected into a single image viewer
    $('#use_multiple_image_views').on('change', function () {
        extension_settings[extensionName].useMultipleImageViews =
            $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Process edited messages checkbox
    // When enabled, adding <pic> tags to existing messages via edit will trigger image generation
    $('#process_edited_messages').on('change', function () {
        extension_settings[extensionName].processEditedMessages =
            $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Max image generations per message input
    // Also determines how many images are generated per <pic> tag
    // Prevents infinite loops when regex transformations create new <pic> tags
    $('#max_image_generations_per_message').on('input', function () {
        const value = parseInt(String($(this).val()));
        extension_settings[extensionName].maxImageGenerationsPerMessage = isNaN(value) || value < 0
            ? 1
            : value;
        saveSettingsDebounced();
    });

    // ---------- ComfyUI Workflows renderer handler ----------
    // Nur der Toggle — base_url und workflow kommen aus der separaten
    // st-comfyui-workflows-Extension (siehe generateViaComfyUiWorkflows()).
    $('#comfyui_wf_enabled').on('change', function () {
        if (!extension_settings[extensionName].comfyui_wf) {
            extension_settings[extensionName].comfyui_wf = { ...defaultSettings.comfyui_wf };
        }
        extension_settings[extensionName].comfyui_wf.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        updateUI();   // damit der Hint mit aktuellen Werten frisch gerendert wird
    });

    // Reset all settings to defaults
    // - Replaces extension_settings[extensionName] entirely with a deep clone of defaultSettings
    //   so future mutations don't accidentally bleed into the defaults object.
    // - Asks for confirmation because regex/prompt customizations are lost.
    // - Calls updateUI() to re-populate every form field, then saveSettingsDebounced().
    $('#image_generation_reset_defaults').on('click', function () {
        // eslint-disable-next-line no-alert
        if (!confirm('Reset ALL Image Auto Generation settings to their defaults?\n\nThis will overwrite your prompt template, regex and every option.')) {
            return;
        }
        // Deep clone to avoid sharing references with the defaultSettings object
        const fresh = JSON.parse(JSON.stringify(defaultSettings));
        for (const key of Object.keys(extension_settings[extensionName])) {
            delete extension_settings[extensionName][key];
        }
        Object.assign(extension_settings[extensionName], fresh);
        updateUI();
        saveSettingsDebounced();
        try {
            toastr.success('Image Auto Generation: defaults restored.');
        } catch (_) { /* toastr may be unavailable in some contexts */ }
        console.log(`[${extensionName}] All settings reset to defaults`);
    });

    // Initialize UI with current settings values
    updateUI();
}

/**
 * Handles clicks on the extension menu button
 * Opens the extension settings panel and scrolls to this extension's settings
 * Also expands the settings drawer if it's collapsed
 */
function onExtensionButtonClick() {
    // Access the extension settings panel directly
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');

    // If the drawer is closed, click to open it
    if ($('#rm_extensions_block').hasClass('closedDrawer')) {
        extensionsDrawer.trigger('click');
    }

    // Wait for the drawer to open, then scroll to our settings container
    setTimeout(() => {
        // Find our settings container
        const container = $('#image_auto_generation_container');
        if (container.length) {
            // Scroll to the settings panel position
            $('#rm_extensions_block').animate(
                {
                    scrollTop:
                        container.offset().top -
                        $('#rm_extensions_block').offset().top +
                        $('#rm_extensions_block').scrollTop(),
                },
                500,
            );

            // Use SillyTavern's native drawer expansion method
            // Check if the drawer content is visible
            const drawerContent = container.find('.inline-drawer-content');
            const drawerHeader = container.find('.inline-drawer-header');

            // Only trigger expansion if content is hidden
            if (drawerContent.is(':hidden') && drawerHeader.length) {
                // Use native click event to trigger expansion
                drawerHeader.trigger('click');
            }
        }
    }, 500);
}

/**
 * Initializes the extension when the page loads
 * Sets up the extension menu button, loads settings, and creates the settings panel
 */
$(function () {
    (async function () {
        // Fetch settings HTML (only once)
        const settingsHtml = await $.get(
            `${extensionFolderPath}/settings.html`,
        );

        // Add extension to the extensions menu
        $('#extensionsMenu')
            .append(`<div id="auto_generation" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-robot"></div>
            <span data-i18n="Image Auto Generation">Image Auto Generation</span>
        </div>`);

        // Set up click event to open settings panel instead of toggling state
        $('#auto_generation').off('click').on('click', onExtensionButtonClick);

        // Load extension settings
        await loadSettings();

        // Create settings panel - pass the fetched HTML to createSettings
        await createSettings(settingsHtml);

        // Ensure settings values are correct when the settings panel becomes visible
        $('#extensions-settings-button').on('click', function () {
            setTimeout(() => {
                updateUI();
            }, 200);
        });
    })();
});

/**
 * Gets the message role based on the prompt injection position setting
 * Maps the position setting (deep_system, deep_user, deep_assistant) to the actual role
 *
 * @returns {string} - The message role: 'system', 'user', or 'assistant'
 */
function getMesRole() {
    // Ensure the object path exists
    if (
        !extension_settings[extensionName] ||
        !extension_settings[extensionName].promptInjection ||
        !extension_settings[extensionName].promptInjection.position
    ) {
        return 'system'; // Default to system role
    }

    // Map position setting to actual role
    switch (extension_settings[extensionName].promptInjection.position) {
        case 'deep_system':
            return 'system';
        case 'deep_user':
            return 'user';
        case 'deep_assistant':
            return 'assistant';
        default:
            return 'system';
    }
}

/**
 * Listens for CHAT_COMPLETION_PROMPT_READY event to inject prompt instructions
 * This event fires before the chat completion is sent to the AI,
 * allowing us to inject instructions that tell the AI to include <pic> tags in its responses
 */
eventSource.on(
    event_types.CHAT_COMPLETION_PROMPT_READY,
    async function (eventData) {
        try {
            // Ensure settings object and promptInjection object exist
            // Also check if prompt injection is enabled and extension is not disabled
            if (
                !extension_settings[extensionName] ||
                !extension_settings[extensionName].promptInjection ||
                !extension_settings[extensionName].promptInjection.enabled ||
                extension_settings[extensionName].insertType ===
                    INSERT_TYPE.DISABLED
            ) {
                return;
            }

            // Get prompt injection configuration
            const prompt =
                extension_settings[extensionName].promptInjection.prompt;
            const depth =
                extension_settings[extensionName].promptInjection.depth || 0;
            const role = getMesRole();

            console.log(
                `[${extensionName}] Preparing to inject prompt: role=${role}, depth=${depth}`,
            );
            console.log(
                `[${extensionName}] Prompt content: ${prompt.substring(0, 50)}...`,
            );

            // Determine insertion position based on depth parameter
            if (depth === 0) {
                // Add to the end of the chat array
                eventData.chat.push({ role: role, content: prompt });
                console.log(`[${extensionName}] Prompt added to end of chat`);
            } else {
                // Insert from the end at the specified position
                // depth=1 means insert before the last message, depth=2 means before the second-to-last, etc.
                eventData.chat.splice(-depth, 0, {
                    role: role,
                    content: prompt,
                });
                console.log(
                    `[${extensionName}] Prompt inserted at position ${depth} from the end`,
                );
            }
        } catch (error) {
            console.error(`[${extensionName}] Prompt injection error:`, error);
            toastr.error(`Prompt injection error: ${error}`);
        }
    },
);

/**
 * Listens for CHARACTER_MESSAGE_RENDERED event to process incoming AI messages
 * This event fires after the message has been rendered and regex transformations have been applied.
 * We use this instead of MESSAGE_RECEIVED to ensure we search in the regex-transformed message.
 *
 * IMPORTANT: We must manually apply regex transformations before searching for <pic> tags,
 * because SillyTavern applies regex transformations to messages, and we need to search
 * in the transformed message, not the raw one. Otherwise, tags that were transformed by regex
 * won't be found.
 */
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleIncomingMessage);

/**
 * Listens for MESSAGE_RECEIVED event to process user messages (if enabled)
 * This allows processing <pic> tags in user messages, such as from Quick Replies.
 * Note: For user messages, we also need to apply regex transformations manually.
 */
eventSource.on(event_types.MESSAGE_RECEIVED, function (messageId) {
    // Only process if user message processing is enabled
    if (
        extension_settings[extensionName] &&
        extension_settings[extensionName].processUserMessages
    ) {
        // Use a small delay to ensure the message is fully processed
        setTimeout(() => {
            handleIncomingMessage(messageId);
        }, 100);
    }
});

/**
 * Listens for MESSAGE_UPDATED event to process edited messages (if enabled)
 * This allows processing <pic> tags when users edit existing messages and add <pic> tags
 * The messageIdentifier is cleared when a message is updated to allow re-processing
 */
eventSource.on(event_types.MESSAGE_UPDATED, function (messageId) {
    // Only process if edited message processing is enabled
    if (
        extension_settings[extensionName] &&
        extension_settings[extensionName].processEditedMessages &&
        extension_settings[extensionName].insertType !== INSERT_TYPE.DISABLED
    ) {
        // Clear the processed flag for this message to allow re-processing after edit
        // This is safe because the message content has changed, so we want to check it again
        const messageIdentifier = `msg_${messageId}`;
        processedMessages.delete(messageIdentifier);

        // Reset the generation count when message is edited by the USER, so new <pic> tags can be processed
        // This allows users to add new <pic> tags via edit and have them processed
        // IMPORTANT: Only reset if we're not currently processing this message ourselves
        // (to prevent infinite loops when we emit MESSAGE_UPDATED after generating images)
        const context = getContext();
        const message = context.chat[messageId];
        if (message && message.extra) {
            // Check if we're currently processing this message (indicated by processedMessages Set)
            const messageIdentifier = `msg_${messageId}`;
            const isCurrentlyProcessing = processedMessages.has(messageIdentifier);

            // Store the original message text to detect if it was actually edited by the user
            // If the message text hasn't changed, it's likely our own update, not a user edit
            if (!message.extra._last_processed_mes) {
                message.extra._last_processed_mes = message.mes;
            }
            const messageTextChanged = message.extra._last_processed_mes !== message.mes;

            // Check if we're updating the message ourselves (indicated by _extension_updating flag)
            const isExtensionUpdate = message.extra._extension_updating === true;

            // Only reset if:
            // 1. We're NOT currently processing (meaning it's not our own update)
            // 2. We're NOT updating the message ourselves (indicated by flag)
            // 3. The message text has changed (meaning it's a real user edit, not just our extra update)
            if (!isCurrentlyProcessing && !isExtensionUpdate && messageTextChanged) {
                message.extra.image_generation_count = 0;
                message.extra._last_processed_mes = message.mes; // Update stored text
                console.log(`[${extensionName}] Reset generation count for user-edited message ${messageId} (message text changed)`);
            } else {
                if (isCurrentlyProcessing) {
                    console.log(`[${extensionName}] Skipping generation count reset for message ${messageId} (currently being processed by extension)`);
                } else if (isExtensionUpdate) {
                    console.log(`[${extensionName}] Skipping generation count reset for message ${messageId} (extension is updating message)`);
                } else if (!messageTextChanged) {
                    console.log(`[${extensionName}] Skipping generation count reset for message ${messageId} (message text unchanged, likely extension update)`);
                }
            }
        }

        // Use a small delay to ensure the message is fully updated
        setTimeout(() => {
            handleIncomingMessage(messageId);
        }, 200);
    }
});

/**
 * Listens for IMAGE_SWIPED event to update the title (prompt) when user swipes between images
 * When user swipes, SillyTavern's onImageSwiped updates message.extra.image, and we need to update message.extra.title
 * to match the current image from the image_titles array
 *
 * IMPORTANT: The event is emitted when the button is clicked, but onImageSwiped updates the image.
 * We calculate the new index based on the direction to update the title immediately, then verify after a delay.
 */
eventSource.on(event_types.IMAGE_SWIPED, function ({ message, element, direction }) {
    // Only process if message has image_swipes and image_titles
    if (!message || !message.extra || !Array.isArray(message.extra.image_swipes) || !Array.isArray(message.extra.image_titles)) {
        return;
    }

    // Check if image_swipes and image_titles are parallel (same length)
    if (message.extra.image_swipes.length !== message.extra.image_titles.length) {
        console.warn(`[${extensionName}] image_swipes and image_titles arrays are not parallel`);
        return;
    }

    if (message.extra.image_swipes.length === 0) {
        return;
    }

    // Find the current image index BEFORE the swipe
    const currentIndex = message.extra.image_swipes.indexOf(message.extra.image);
    if (currentIndex === -1) {
        console.warn(`[${extensionName}] Current image not found in image_swipes`);
        return;
    }

    // Calculate the new index based on direction (same logic as onImageSwiped)
    let newIndex;
    if (direction === 'left') {
        // Switch to previous image or wrap around if at the beginning
        newIndex = currentIndex === 0 ? message.extra.image_swipes.length - 1 : currentIndex - 1;
    } else if (direction === 'right') {
        // Switch to next image (or generate new one if at end, but we can't predict that)
        // For now, just handle the case where we're not at the end
        newIndex = currentIndex === message.extra.image_swipes.length - 1 ? currentIndex : currentIndex + 1;
    } else {
        return;
    }

    // Update the title immediately based on the calculated new index
    if (newIndex >= 0 && newIndex < message.extra.image_titles.length) {
        const titleForNewImage = message.extra.image_titles[newIndex] || '';
        message.extra.title = titleForNewImage;
        console.log(`[${extensionName}] Updated title for swipe ${direction} to image ${newIndex + 1}/${message.extra.image_swipes.length}: ${titleForNewImage.substring(0, 50)}...`);

        // Update the image title attribute in the DOM after a small delay to ensure the image has been updated
        setTimeout(() => {
            if (element) {
                const image = element.find('.mes_img');
                if (image.length > 0) {
                    image.attr('title', titleForNewImage);
                }
            }
            // Verify that the image was actually updated correctly
            const actualIndex = message.extra.image_swipes.indexOf(message.extra.image);
            if (actualIndex !== newIndex && actualIndex >= 0 && actualIndex < message.extra.image_titles.length) {
                // Image index doesn't match our calculation, update title again
                const actualTitle = message.extra.image_titles[actualIndex] || '';
                if (message.extra.title !== actualTitle) {
                    message.extra.title = actualTitle;
                    console.log(`[${extensionName}] Corrected title after verification: ${actualTitle.substring(0, 50)}...`);
                    if (element) {
                        const image = element.find('.mes_img');
                        if (image.length > 0) {
                            image.attr('title', actualTitle);
                        }
                    }
                }
            }
            // Save the change to persist the updated title
            const context = getContext();
            context.saveChat();
        }, 100); // Small delay to ensure onImageSwiped has updated the image
    }
});

/**
 * Handles incoming messages and generates images when <pic> tags are detected
 * Can process both AI messages and user messages (if processUserMessages is enabled)
 *
 * @param {number} messageId - The index of the message in the chat array (optional)
 */
async function handleIncomingMessage(messageId) {
    console.log(`[${extensionName}] handleIncomingMessage called with messageId: ${messageId}`);

    // Ensure settings object exists and extension is not disabled
    if (
        !extension_settings[extensionName] ||
        extension_settings[extensionName].insertType === INSERT_TYPE.DISABLED
    ) {
        console.log(`[${extensionName}] Extension disabled or settings not found, returning`);
        return;
    }

    const context = getContext();

    // Use messageId parameter if provided, otherwise use the last message
    const messageIndex = typeof messageId === 'number' ? messageId : (context.chat.length - 1);
    const message = context.chat[messageIndex];

    // Check if message exists
    if (!message) {
        return;
    }

    // Check if this is a user message and if user message processing is disabled
    if (message.is_user && !extension_settings[extensionName].processUserMessages) {
        return;
    }

    // CRITICAL: Prevent infinite loops by checking if this message has already been processed
    // When we update a message (e.g., replace <pic> tags or add images), it can trigger
    // new events that would cause this function to run again. We use a global Set to track
    // processed messages using messageIndex (which is stable and doesn't change when content changes)
    const messageIdentifier = `msg_${messageIndex}`;

    // Check if this message is currently being processed or has already been processed
    if (processedMessages.has(messageIdentifier)) {
        console.log(`[${extensionName}] Message ${messageIndex} already being processed, skipping to prevent infinite loop`);
        return;
    }

    // Mark as processed IMMEDIATELY, before any processing
    processedMessages.add(messageIdentifier);
    console.log(`[${extensionName}] Processing message ${messageIndex}`);

    // Ensure promptInjection object and regex property exist
    if (
        !extension_settings[extensionName].promptInjection ||
        !extension_settings[extensionName].promptInjection.regex
    ) {
        console.error('Prompt injection settings not properly initialized');
        return;
    }

    // Optionally apply regex transformations before searching for <pic> tags
    // Regex transformations are normally only applied in messageFormatting(),
    // but message.mes contains the raw message without regex replacements.
    // If applyRegexTransformations is enabled, we apply regex to find tags that may have been transformed.
    let messageText = message.mes;
    let regexPlacement = null;

    // Only apply regex transformations if the option is enabled
    if (extension_settings[extensionName].applyRegexTransformations) {
        // Calculate the depth for regex application (similar to how messageFormatting does it)
        // This determines which regex rules apply based on message position in the conversation
        const usableMessages = context.chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
        const indexOf = usableMessages.findIndex(x => x.index === messageIndex);
        const depth = messageIndex >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;

        // Apply regex transformations, exactly like SillyTavern does in messageFormatting()
        // Use USER_INPUT for user messages, AI_OUTPUT for AI messages
        // If USER_INPUT doesn't exist, fall back to AI_OUTPUT
        regexPlacement = message.is_user
            ? (regex_placement.USER_INPUT || regex_placement.AI_OUTPUT)
            : regex_placement.AI_OUTPUT;

        messageText = getRegexedString(messageText, regexPlacement, {
            characterOverride: message.name,
            isMarkdown: false, // We're searching for raw tags, not formatted HTML
            depth: depth,
        });

        console.log(`[${extensionName}] Original message: ${message.mes.substring(0, 100)}...`);
        console.log(`[${extensionName}] After regex: ${messageText.substring(0, 100)}...`);
    } else {
        console.log(`[${extensionName}] Searching in raw message (regex transformations disabled): ${message.mes.substring(0, 100)}...`);
    }

    // Search for image tags using regex - search in the regex-transformed message
    const imgTagRegex = regexFromString(
        extension_settings[extensionName].promptInjection.regex,
    );

    let matches;
    if (imgTagRegex.global) {
        matches = [...messageText.matchAll(imgTagRegex)];
    } else {
        const singleMatch = messageText.match(imgTagRegex);
        matches = singleMatch ? [singleMatch] : [];
    }

    console.log(`[${extensionName}] Found ${matches.length} matches:`, matches);

    // If no matches found, return early
    if (matches.length === 0) {
        console.log(`[${extensionName}] No image tags found in message ${messageIndex}`);
        return;
    }

    // CRITICAL: Check if we've already generated images for this message the maximum number of times
    // This prevents infinite loops when regex transformations create new <pic> tags
    const maxGenerations = extension_settings[extensionName].maxImageGenerationsPerMessage || 1;
    if (maxGenerations > 0) {
        // Initialize message.extra if it doesn't exist
        if (!message.extra) {
            message.extra = {};
        }
        const generationCount = message.extra.image_generation_count || 0;

        if (generationCount >= maxGenerations) {
            console.log(`[${extensionName}] Message ${messageIndex} has already generated images ${generationCount} time(s) (max: ${maxGenerations}), skipping to prevent infinite loop`);
            return;
        }

        // Increment the generation count BEFORE processing
        // This prevents re-processing even if events are triggered during image generation
        message.extra.image_generation_count = generationCount + 1;
        // Store the current message text to detect user edits later
        message.extra._last_processed_mes = message.mes;
        console.log(`[${extensionName}] Generation count for message ${messageIndex}: ${message.extra.image_generation_count}/${maxGenerations}`);
    }

    if (matches.length > 0) {
        // Calculate how many images per tag based on the viewer type
        // This must be done before the toast notification to show the correct total count
        const insertType = extension_settings[extensionName].insertType;
        let imagesPerTag = 1; // Default: 1 image per tag

        if (insertType === INSERT_TYPE.INLINE) {
            // INLINE mode always uses swipe image viewer
            imagesPerTag = extension_settings[extensionName].maxImageGenerationsPerMessage || 1;
        } else if (insertType === INSERT_TYPE.REPLACE) {
            const useImageViewer = extension_settings[extensionName].replaceModeUseImageViewer !== false; // Default to true
            const useMultipleViews = extension_settings[extensionName].useMultipleImageViews === true;

            // Only use multiple images if we're using the swipe image viewer (not simple <img> tags or multiple separate viewers)
            if (useImageViewer && !useMultipleViews) {
                imagesPerTag = extension_settings[extensionName].maxImageGenerationsPerMessage || 1;
            }
        }
        // For NEW_MESSAGE mode or other cases, always use 1 image per tag

        // Calculate total number of images to generate
        const totalImagesToGenerate = matches.length * imagesPerTag;

        // Delay image generation to ensure the message is displayed first
        // This prevents blocking the UI rendering
        // Note: Message is already marked as processed above to prevent infinite loops
        setTimeout(async () => {
            try {
                toastr.info(`Generating ${totalImagesToGenerate} images...`);

                // Initialize message.extra for image insertion
                if (!message.extra) {
                    message.extra = {};
                }

                // Initialize image_swipes array for multiple images
                if (!Array.isArray(message.extra.image_swipes)) {
                    message.extra.image_swipes = [];
                }
                // Initialize image_titles array to store prompts for each image in image_swipes
                // This array must be parallel to image_swipes (same index = same image)
                if (!Array.isArray(message.extra.image_titles)) {
                    message.extra.image_titles = [];
                }

                // CRITICAL: If there's already an image, ensure it's in the swipes array
                // This is required for swipe functionality to work - SillyTavern needs at least 2 items in image_swipes
                // If message.extra.image exists but is not in image_swipes, add it first
                if (message.extra.image) {
                    if (!message.extra.image_swipes.includes(message.extra.image)) {
                        // Add existing image to the beginning of the array to preserve order
                        message.extra.image_swipes.unshift(message.extra.image);
                        // Also add the existing title to image_titles at the same index
                        if (message.extra.title) {
                            message.extra.image_titles.unshift(message.extra.title);
                        } else {
                            message.extra.image_titles.unshift('');
                        }
                    } else {
                        // Image is already in swipes, but ensure image_titles has a corresponding entry
                        const existingIndex = message.extra.image_swipes.indexOf(message.extra.image);
                        if (existingIndex >= 0 && existingIndex < message.extra.image_titles.length) {
                            // Entry exists, update it if we have a title
                            if (message.extra.title && message.extra.image_titles[existingIndex] !== message.extra.title) {
                                message.extra.image_titles[existingIndex] = message.extra.title;
                            }
                        } else {
                            // Entry doesn't exist, add it at the correct position
                            // This shouldn't happen, but handle it gracefully
                            while (message.extra.image_titles.length < existingIndex) {
                                message.extra.image_titles.push('');
                            }
                            message.extra.image_titles[existingIndex] = message.extra.title || '';
                        }
                    }
                }

                // Get the message element for later UI updates
                const messageElement = $(
                    `.mes[mesid="${messageIndex}"]`,
                );

                // Collect all image generation tasks first
                // This allows us to process all images and then update the UI once at the end
                const imageGenerationTasks = [];

                // imagesPerTag was already calculated above before the toast notification
                for (const match of matches) {
                    // Extract the prompt from the first capture group
                    const prompt =
                        typeof match?.[1] === 'string' ? match[1] : '';
                    if (!prompt.trim()) {
                        continue;
                    }

                    // Add the task - each tag generates imagesPerTag images
                    imageGenerationTasks.push({
                        match: match,
                        prompt: prompt,
                        count: imagesPerTag, // Use the calculated count based on viewer type
                    });
                }

                // Generate all images first, then update UI once
                // If imagesPerTag > 1, generate multiple images for each tag
                const generatedImages = [];
                for (const task of imageGenerationTasks) {
                    const count = task.count || 1; // Default to 1 if not specified
                    console.log(`[${extensionName}] Generating ${count} image(s) with prompt: ${task.prompt}`);

                    // Generate the image count times
                    // Routing: wenn cw.enabled, bypass /sd-Slash und call
                    // direkt unsere comfyui-api. Sonst original-Pfad ueber den
                    // konfigurierten ST-SD-source. Beide Wege liefern entweder
                    // einen URL-String (file:// oder /user/images/...) oder
                    // eine `data:image/...`-URL die der Image-Viewer rendert.
                    const useCw = !!(extension_settings[extensionName].comfyui_wf &&
                                          extension_settings[extensionName].comfyui_wf.enabled);
                    for (let i = 0; i < count; i++) {
                        let result;
                        if (useCw) {
                            result = await generateViaComfyUiWorkflows(task.prompt);
                        } else {
                            // Call the Stable Diffusion slash command to generate the image
                            // @ts-ignore
                            result = await SlashCommandParser.commands[
                                'sd'
                            ].callback(
                                {
                                    // quiet: 'true' suppresses toast notifications (except for NEW_MESSAGE mode)
                                    quiet:
                                        insertType === INSERT_TYPE.NEW_MESSAGE
                                            ? 'false'
                                            : 'true',
                                },
                                task.prompt,
                            );
                        }

                        if (typeof result === 'string' && result.trim().length > 0) {
                            generatedImages.push({
                                url: result,
                                prompt: task.prompt,
                                match: task.match,
                            });
                            console.log(`[${extensionName}] Generated image ${i + 1}/${count} via ${useCw ? 'comfyui_wf' : '/sd'} for prompt: ${task.prompt.substring(0, 50)}...`);
                        }
                    }
                }

                // Now process all generated images at once
                if (generatedImages.length > 0) {
                    // Insert images based on the selected insertion type
                    if (insertType === INSERT_TYPE.INLINE) {
                        // INLINE mode: Insert images into message.extra array (supports image controls)
                        // Add all images to swipes array and store their prompts in image_titles array
                        // image_titles must be parallel to image_swipes (same index = same image)
                        for (const img of generatedImages) {
                            const existingIndex = message.extra.image_swipes.indexOf(img.url);
                            if (existingIndex === -1) {
                                // Image not in swipes yet, add it
                                message.extra.image_swipes.push(img.url);
                                message.extra.image_titles.push(img.prompt);
                            } else {
                                // Image already exists, update its prompt in image_titles
                                message.extra.image_titles[existingIndex] = img.prompt;
                            }
                        }

                        // CRITICAL: Ensure message.extra.image is set and is in image_swipes
                        // This is required for swipe functionality - SillyTavern needs message.extra.image
                        // to match the first item in image_swipes for proper swipe behavior
                        if (message.extra.image_swipes.length > 0) {
                            // If message.extra.image is not set, use the first image
                            if (!message.extra.image) {
                                message.extra.image = message.extra.image_swipes[0];
                                const firstImageData = generatedImages.find(img => img.url === message.extra.image_swipes[0]);
                                if (firstImageData) {
                                    message.extra.title = firstImageData.prompt;
                                }
                            }
                            // Ensure message.extra.image is the first item in image_swipes
                            // This is important for swipe functionality
                            const currentImageIndex = message.extra.image_swipes.indexOf(message.extra.image);
                            if (currentImageIndex > 0) {
                                // Move current image to the front
                                const imageUrl = message.extra.image_swipes.splice(currentImageIndex, 1)[0];
                                message.extra.image_swipes.unshift(imageUrl);
                                // Also move the corresponding title to maintain parallel arrays
                                const imageTitle = message.extra.image_titles.splice(currentImageIndex, 1)[0];
                                message.extra.image_titles.unshift(imageTitle);
                                // Update message.extra.title to match the moved image
                                message.extra.title = imageTitle;
                                console.log(`[${extensionName}] Moved image to front and updated title: ${imageTitle.substring(0, 50)}...`);
                            } else if (currentImageIndex === 0) {
                                // Image is already first, but ensure title matches
                                const titleFromArray = message.extra.image_titles[0] || '';
                                if (message.extra.title !== titleFromArray) {
                                    message.extra.title = titleFromArray;
                                    console.log(`[${extensionName}] Updated title to match current image: ${titleFromArray.substring(0, 50)}...`);
                                }
                            }
                        }
                        message.extra.inline_image = true;

                        // CRITICAL: Ensure message.extra.image matches the first item in image_swipes
                        // This is required for SillyTavern's swipe functionality to work correctly
                        // Also update the title (prompt) to match the current image from image_titles array
                        if (message.extra.image_swipes.length > 0) {
                            const firstImageUrl = message.extra.image_swipes[0];
                            if (message.extra.image !== firstImageUrl) {
                                message.extra.image = firstImageUrl;
                                // Get the prompt from image_titles array (parallel to image_swipes)
                                const firstImageTitle = message.extra.image_titles[0] || '';
                                message.extra.title = firstImageTitle;
                                console.log(`[${extensionName}] Updated image and title from array: ${firstImageTitle.substring(0, 50)}...`);
                            } else {
                                // Even if image matches, ensure title is correct from image_titles array
                                const firstImageTitle = message.extra.image_titles[0] || '';
                                if (message.extra.title !== firstImageTitle) {
                                    message.extra.title = firstImageTitle;
                                    console.log(`[${extensionName}] Updated title to match current image from array: ${firstImageTitle.substring(0, 50)}...`);
                                }
                            }
                        }

                        // Update the UI to display all images at once
                        appendMediaToMessage(message, messageElement);

                        // Save the chat to persist the changes
                        await context.saveChat();
                    } else if (insertType === INSERT_TYPE.REPLACE) {
                        // REPLACE mode: Replace the <pic> tag in the message text
                        // Can use either SillyTavern's image viewer (with zoom, prompt display, seed regeneration)
                        // or simple <img> tags, depending on the replaceModeUseImageViewer setting

                        // Check if image viewer should be used in REPLACE mode
                        const useImageViewer = extension_settings[extensionName].replaceModeUseImageViewer !== false; // Default to true
                        // Check if multiple separate image viewers should be used
                        const useMultipleViews = extension_settings[extensionName].useMultipleImageViews === true;

                        if (useImageViewer) {
                            if (useMultipleViews && generatedImages.length > 1) {
                                // Use multiple separate image viewers: Replace each <pic> tag with an inline image viewer
                                // Each image gets its own viewer at the position of the original tag
                                // If regex transformations were applied, we need to work with the transformed message
                                let messageTextToProcess = message.mes;
                                if (extension_settings[extensionName].applyRegexTransformations && regexPlacement) {
                                    const usableMessages = context.chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
                                    const indexOf = usableMessages.findIndex(x => x.index === messageIndex);
                                    const depth = messageIndex >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;
                                    messageTextToProcess = getRegexedString(message.mes, regexPlacement, {
                                        characterOverride: message.name,
                                        isMarkdown: false,
                                        depth: depth,
                                    });
                                }

                                for (const img of generatedImages) {
                                    const originalTag = typeof img.match?.[0] === 'string' ? img.match[0] : '';
                                    if (!originalTag) {
                                        continue;
                                    }

                                    // Replace the tag with a special placeholder that will be converted to an image viewer
                                    const escapedUrl = escapeHtmlAttribute(img.url);
                                    const escapedPrompt = escapeHtmlAttribute(img.prompt);
                                    // Use a div with inline image - title attribute is sufficient for hover tooltip
                                    // This allows multiple viewers in one message
                                    const imageViewerPlaceholder = `<div class="inline-image-viewer" style="display: inline-block; margin: 4px;"><img src="${escapedUrl}" title="${escapedPrompt}" onclick="window.open('${escapedUrl}', '_blank')"></div>`;

                                    messageTextToProcess = messageTextToProcess.replace(originalTag, imageViewerPlaceholder);
                                }

                                // Update message.mes with the processed text
                                message.mes = messageTextToProcess;

                                // Save the chat first to persist the message changes
                                await context.saveChat();

                                // Update the message display using updateMessageBlock (only once, after all replacements)
                                // Use a small delay to ensure the message element exists in the DOM
                                // This is especially important for normal events (not Edit), where the message might not be fully rendered yet
                                setTimeout(() => {
                                    const messageElement = $(
                                        `.mes[mesid="${messageIndex}"]`,
                                    );
                                    if (messageElement.length > 0) {
                                        updateMessageBlock(
                                            messageIndex,
                                            message,
                                        );
                                        console.log(`[${extensionName}] Updated message block for multiple inline viewers`);
                                    } else {
                                        console.warn(`[${extensionName}] Message element not found for index ${messageIndex}, retrying...`);
                                        // Retry once after a longer delay
                                        setTimeout(() => {
                                            const retryElement = $(
                                                `.mes[mesid="${messageIndex}"]`,
                                            );
                                            if (retryElement.length > 0) {
                                                updateMessageBlock(
                                                    messageIndex,
                                                    message,
                                                );
                                                console.log(`[${extensionName}] Updated message block for multiple inline viewers (retry)`);
                                            } else {
                                                console.error(`[${extensionName}] Message element still not found after retry for index ${messageIndex}`);
                                            }
                                        }, 500);
                                    }
                                }, 100);
                            } else {
                                // Use single combined image viewer: Remove all <pic> tags and add images to message.extra
                                // This provides zoom, prompt display, and seed regeneration features

                                // Remove all <pic> tags from the message text
                                // If regex transformations were applied, we need to work with the transformed message
                                // and then update message.mes with the result
                                let messageTextToProcess = message.mes;
                                if (extension_settings[extensionName].applyRegexTransformations && regexPlacement) {
                                    // Use the regex-transformed message for replacement
                                    const usableMessages = context.chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
                                    const indexOf = usableMessages.findIndex(x => x.index === messageIndex);
                                    const depth = messageIndex >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;
                                    messageTextToProcess = getRegexedString(message.mes, regexPlacement, {
                                        characterOverride: message.name,
                                        isMarkdown: false,
                                        depth: depth,
                                    });
                                }

                                for (const img of generatedImages) {
                                    const originalTag = typeof img.match?.[0] === 'string' ? img.match[0] : '';
                                    if (!originalTag) {
                                        continue;
                                    }

                                    // Replace the tag in the processed message text
                                    messageTextToProcess = messageTextToProcess.replace(originalTag, '');
                                }

                                // Update message.mes with the processed text
                                message.mes = messageTextToProcess;

                                // Add all images to message.extra to use SillyTavern's image viewer
                                if (!message.extra) {
                                    message.extra = {};
                                }
                                if (!Array.isArray(message.extra.image_swipes)) {
                                    message.extra.image_swipes = [];
                                }
                                // Initialize image_titles array to store prompts for each image in image_swipes
                                if (!Array.isArray(message.extra.image_titles)) {
                                    message.extra.image_titles = [];
                                }

                                // Add all images to swipes array and store their prompts in image_titles array
                                // image_titles must be parallel to image_swipes (same index = same image)
                                for (const img of generatedImages) {
                                    const existingIndex = message.extra.image_swipes.indexOf(img.url);
                                    if (existingIndex === -1) {
                                        // Image not in swipes yet, add it
                                        message.extra.image_swipes.push(img.url);
                                        message.extra.image_titles.push(img.prompt);
                                    } else {
                                        // Image already exists, update its prompt in image_titles
                                        message.extra.image_titles[existingIndex] = img.prompt;
                                    }
                                }

                                // CRITICAL: Ensure message.extra.image is set and is in image_swipes
                                // This is required for swipe functionality - SillyTavern needs message.extra.image
                                // to match the first item in image_swipes for proper swipe behavior
                                if (message.extra.image_swipes.length > 0) {
                                    // If message.extra.image is not set, use the first image
                                    if (!message.extra.image) {
                                        message.extra.image = message.extra.image_swipes[0];
                                        const firstImageData = generatedImages.find(img => img.url === message.extra.image_swipes[0]);
                                        if (firstImageData) {
                                            message.extra.title = firstImageData.prompt;
                                        }
                                    }
                                    // Ensure message.extra.image is the first item in image_swipes
                                    // This is important for swipe functionality
                                    const currentImageIndex = message.extra.image_swipes.indexOf(message.extra.image);
                                    if (currentImageIndex > 0) {
                                        // Move current image to the front
                                        const imageUrl = message.extra.image_swipes.splice(currentImageIndex, 1)[0];
                                        message.extra.image_swipes.unshift(imageUrl);
                                        // Also move the corresponding title to maintain parallel arrays
                                        const imageTitle = message.extra.image_titles.splice(currentImageIndex, 1)[0];
                                        message.extra.image_titles.unshift(imageTitle);
                                        // Update message.extra.title to match the moved image
                                        message.extra.title = imageTitle;
                                        console.log(`[${extensionName}] Moved image to front and updated title: ${imageTitle.substring(0, 50)}...`);
                                    } else if (currentImageIndex === 0) {
                                        // Image is already first, but ensure title matches
                                        const titleFromArray = message.extra.image_titles[0] || '';
                                        if (message.extra.title !== titleFromArray) {
                                            message.extra.title = titleFromArray;
                                            console.log(`[${extensionName}] Updated title to match current image: ${titleFromArray.substring(0, 50)}...`);
                                        }
                                    }
                                }
                                message.extra.inline_image = true;

                                // CRITICAL: Ensure message.extra.image matches the first item in image_swipes
                                // This is required for SillyTavern's swipe functionality to work correctly
                                // SillyTavern checks if image_swipes.length > 1 and if message.extra.image matches the first item
                                // Also update the title (prompt) to match the current image from image_titles array
                                if (message.extra.image_swipes.length > 0) {
                                    const firstImageUrl = message.extra.image_swipes[0];
                                    if (message.extra.image !== firstImageUrl) {
                                        message.extra.image = firstImageUrl;
                                        // Get the prompt from image_titles array (parallel to image_swipes)
                                        const firstImageTitle = message.extra.image_titles[0] || '';
                                        message.extra.title = firstImageTitle;
                                        console.log(`[${extensionName}] Updated image and title from array: ${firstImageTitle.substring(0, 50)}...`);
                                    } else {
                                        // Even if image matches, ensure title is correct from image_titles array
                                        const firstImageTitle = message.extra.image_titles[0] || '';
                                        if (message.extra.title !== firstImageTitle) {
                                            message.extra.title = firstImageTitle;
                                            console.log(`[${extensionName}] Updated title to match current image from array: ${firstImageTitle.substring(0, 50)}...`);
                                        }
                                    }
                                }

                                // Update the UI to display all images with the image viewer (only once)
                                appendMediaToMessage(message, messageElement);
                            }

                            // Update the message display using updateMessageBlock (only once)
                            updateMessageBlock(
                                messageIndex,
                                message,
                            );
                        } else {
                            // Use simple <img> tags: Replace each <pic> tag with an <img> tag
                            // If regex transformations were applied, we need to work with the transformed message
                            let messageTextToProcess = message.mes;
                            if (extension_settings[extensionName].applyRegexTransformations && regexPlacement) {
                                const usableMessages = context.chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
                                const indexOf = usableMessages.findIndex(x => x.index === messageIndex);
                                const depth = messageIndex >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;
                                messageTextToProcess = getRegexedString(message.mes, regexPlacement, {
                                    characterOverride: message.name,
                                    isMarkdown: false,
                                    depth: depth,
                                });
                            }

                            for (const img of generatedImages) {
                                const originalTag = typeof img.match?.[0] === 'string' ? img.match[0] : '';
                                if (!originalTag) {
                                    continue;
                                }

                                const escapedUrl = escapeHtmlAttribute(img.url);
                                const escapedPrompt = escapeHtmlAttribute(img.prompt);
                                // title attribute is sufficient for hover tooltip, no need for redundant alt
                                const newImageTag = `<img src="${escapedUrl}" title="${escapedPrompt}">`;

                                messageTextToProcess = messageTextToProcess.replace(originalTag, newImageTag);
                            }

                            // Update message.mes with the processed text
                            message.mes = messageTextToProcess;
                        }

                        // Update the message display using updateMessageBlock (only once)
                        updateMessageBlock(
                            messageIndex,
                            message,
                        );

                        // Set a flag to indicate we're updating the message ourselves
                        // This prevents the MESSAGE_UPDATED event listener from resetting the generation count
                        if (!message.extra) {
                            message.extra = {};
                        }
                        message.extra._extension_updating = true;

                        await eventSource.emit(
                            event_types.MESSAGE_UPDATED,
                            messageIndex,
                        );

                        // Clear the flag after a short delay to allow event listeners to process
                        setTimeout(() => {
                            if (message.extra) {
                                delete message.extra._extension_updating;
                            }
                        }, 100);

                        // Save the chat to persist the changes
                        await context.saveChat();
                    }
                }
                // Show success message with actual number of generated images
                const actualGeneratedCount = generatedImages.length;
                toastr.success(
                    `${actualGeneratedCount} image${actualGeneratedCount !== 1 ? 's' : ''} generated successfully`,
                );
            } catch (error) {
                toastr.error(`Image generation error: ${error}`);
                console.error(`[${extensionName}] Image generation error:`, error);
            }
        }, 0); // Prevent blocking UI rendering
    }
}
