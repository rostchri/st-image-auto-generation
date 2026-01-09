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
} from '../../../../script.js';
import { appendMediaToMessage } from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
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
 * Default extension settings
 * These are used when the extension is first loaded or when settings are missing
 */
const defaultSettings = {
    // Image insertion type (disabled by default)
    insertType: INSERT_TYPE.DISABLED,
    // Whether to process user messages for <pic> tags (disabled by default)
    // When enabled, the extension will also generate images from <pic> tags in user messages
    // (e.g., from Quick Replies or manual user input)
    processUserMessages: false,
    // Whether to apply SillyTavern regex transformations before searching for <pic> tags (disabled by default)
    // When enabled, regex transformations are applied to messages before searching for tags
    // This is useful if your regex rules transform <pic> tags, but may not be needed in all cases
    applyRegexTransformations: false,
    // Whether to use SillyTavern's image viewer in REPLACE mode (enabled by default)
    // When enabled, images use the full image viewer with zoom, prompt display, and seed regeneration
    // When disabled, images are inserted as simple <img> tags in the message text
    replaceModeUseImageViewer: true,
    // Whether to use multiple separate image viewers (one per <pic> tag) instead of one combined viewer (disabled by default)
    // When enabled, each <pic> tag is replaced by its own image viewer at that position in the text
    // When disabled, all images are collected into a single image viewer (current behavior)
    // Note: Multiple viewers may have compatibility issues with some SillyTavern features
    useMultipleImageViews: false,
    // Whether to process <pic> tags when messages are edited (enabled by default)
    // When enabled, adding <pic> tags to existing messages via edit will trigger image generation
    processEditedMessages: true,
    // Prompt injection configuration
    promptInjection: {
        // Whether prompt injection is enabled
        enabled: true,
        // The prompt template that will be injected into the chat completion
        // This instructs the AI to include <pic> tags in its responses
        prompt: `<image_generation>
You must insert a <pic prompt="example prompt"> at end of the reply. Prompts are used for stable diffusion image generation, based on the plot and character to output appropriate prompts to generate captivating images.
</image_generation>`,
        // Regular expression to match <pic> tags in AI messages
        // Must capture the prompt as the first capture group (in parentheses)
        regex: '/<pic[^>]*\\sprompt="([^"]*)"[^>]*?>/g',
        // Position where the prompt should be injected: deep_system, deep_user, or deep_assistant
        position: 'deep_system',
        // Depth: 0 means add to the end, >0 means insert from the end at the specified position
        depth: 0,
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

        // Use a small delay to ensure the message is fully updated
        setTimeout(() => {
            handleIncomingMessage(messageId);
        }, 200);
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

    if (matches.length > 0) {
        // Delay image generation to ensure the message is displayed first
        // This prevents blocking the UI rendering
        // Note: Message is already marked as processed above to prevent infinite loops
        setTimeout(async () => {
            try {
                toastr.info(`Generating ${matches.length} images...`);
                const insertType = extension_settings[extensionName].insertType;

                // Initialize message.extra for image insertion
                if (!message.extra) {
                    message.extra = {};
                }

                // Initialize image_swipes array for multiple images
                if (!Array.isArray(message.extra.image_swipes)) {
                    message.extra.image_swipes = [];
                }

                // CRITICAL: If there's already an image, ensure it's in the swipes array
                // This is required for swipe functionality to work - SillyTavern needs at least 2 items in image_swipes
                // If message.extra.image exists but is not in image_swipes, add it first
                if (message.extra.image) {
                    if (!message.extra.image_swipes.includes(message.extra.image)) {
                        // Add existing image to the beginning of the array to preserve order
                        message.extra.image_swipes.unshift(message.extra.image);
                    }
                }

                // Get the message element for later UI updates
                const messageElement = $(
                    `.mes[mesid="${messageIndex}"]`,
                );

                // Collect all image generation tasks first
                // This allows us to process all images and then update the UI once at the end
                const imageGenerationTasks = [];

                // Process each matched image tag and collect generation tasks
                for (const match of matches) {
                    // Extract the prompt from the first capture group
                    const prompt =
                        typeof match?.[1] === 'string' ? match[1] : '';
                    if (!prompt.trim()) {
                        continue;
                    }

                    imageGenerationTasks.push({
                        match: match,
                        prompt: prompt,
                    });
                }

                // Generate all images first, then update UI once
                const generatedImages = [];
                for (const task of imageGenerationTasks) {
                    console.log(`[${extensionName}] Generating image with prompt: ${task.prompt}`);

                    // Call the Stable Diffusion slash command to generate the image
                    // @ts-ignore
                    const result = await SlashCommandParser.commands[
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

                    if (typeof result === 'string' && result.trim().length > 0) {
                        generatedImages.push({
                            url: result,
                            prompt: task.prompt,
                            match: task.match,
                        });
                    }
                }

                // Now process all generated images at once
                if (generatedImages.length > 0) {
                    // Insert images based on the selected insertion type
                    if (insertType === INSERT_TYPE.INLINE) {
                        // INLINE mode: Insert images into message.extra array (supports image controls)
                        // Add all images to swipes array
                        for (const img of generatedImages) {
                            if (!message.extra.image_swipes.includes(img.url)) {
                                message.extra.image_swipes.push(img.url);
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
                                message.extra.image_swipes.splice(currentImageIndex, 1);
                                message.extra.image_swipes.unshift(message.extra.image);
                                // Update title to match the moved image
                                const movedImageData = generatedImages.find(img => img.url === message.extra.image);
                                if (movedImageData) {
                                    message.extra.title = movedImageData.prompt;
                                    console.log(`[${extensionName}] Updated title after moving image to front: ${movedImageData.prompt.substring(0, 50)}...`);
                                }
                            } else if (currentImageIndex === 0) {
                                // Image is already first, but ensure title matches
                                const currentImageData = generatedImages.find(img => img.url === message.extra.image);
                                if (currentImageData && message.extra.title !== currentImageData.prompt) {
                                    message.extra.title = currentImageData.prompt;
                                    console.log(`[${extensionName}] Updated title to match current image: ${currentImageData.prompt.substring(0, 50)}...`);
                                }
                            }
                        }
                        message.extra.inline_image = true;

                        // CRITICAL: Ensure message.extra.image matches the first item in image_swipes
                        // This is required for SillyTavern's swipe functionality to work correctly
                        // Also update the title (prompt) to match the current image
                        if (message.extra.image_swipes.length > 0) {
                            const firstImageUrl = message.extra.image_swipes[0];
                            if (message.extra.image !== firstImageUrl) {
                                message.extra.image = firstImageUrl;
                                // Find and update the prompt for the current image
                                const currentImageData = generatedImages.find(img => img.url === firstImageUrl);
                                if (currentImageData) {
                                    message.extra.title = currentImageData.prompt;
                                    console.log(`[${extensionName}] Updated image and title: ${currentImageData.prompt.substring(0, 50)}...`);
                                }
                            } else {
                                // Even if image matches, ensure title is correct
                                const currentImageData = generatedImages.find(img => img.url === firstImageUrl);
                                if (currentImageData && message.extra.title !== currentImageData.prompt) {
                                    message.extra.title = currentImageData.prompt;
                                    console.log(`[${extensionName}] Updated title to match current image: ${currentImageData.prompt.substring(0, 50)}...`);
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
                                for (const img of generatedImages) {
                                    const originalTag = typeof img.match?.[0] === 'string' ? img.match[0] : '';
                                    if (!originalTag) {
                                        continue;
                                    }

                                    // If regex transformations are enabled, we need to find the tag in the regex-transformed message
                                    let tagToReplace = originalTag;

                                    if (extension_settings[extensionName].applyRegexTransformations && regexPlacement) {
                                        const usableMessages = context.chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
                                        const indexOf = usableMessages.findIndex(x => x.index === messageIndex);
                                        const depth = messageIndex >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;

                                        const regexedMes = getRegexedString(message.mes, regexPlacement, {
                                            characterOverride: message.name,
                                            isMarkdown: false,
                                            depth: depth,
                                        });

                                        tagToReplace = regexedMes.includes(originalTag)
                                            ? originalTag
                                            : regexedMes.match(new RegExp(`<pic[^>]*prompt="${escapeRegex(img.prompt)}"[^>]*>`, 'g'))?.[0] || originalTag;
                                    }

                                    // Replace the tag with a special placeholder that will be converted to an image viewer
                                    // We use a data attribute to store the image URL and prompt
                                    const escapedUrl = escapeHtmlAttribute(img.url);
                                    const escapedPrompt = escapeHtmlAttribute(img.prompt);
                                    // Use a div with data attributes that can be processed by JavaScript to create image viewers
                                    // This allows multiple viewers in one message
                                    const imageViewerPlaceholder = `<div class="inline-image-viewer" data-image-url="${escapedUrl}" data-prompt="${escapedPrompt}" style="display: inline-block; margin: 4px;"><img src="${escapedUrl}" alt="${escapedPrompt}" title="${escapedPrompt}" onclick="window.open('${escapedUrl}', '_blank')"></div>`;

                                    message.mes = message.mes.replace(tagToReplace, imageViewerPlaceholder);
                                }
                            } else {
                                // Use single combined image viewer: Remove all <pic> tags and add images to message.extra
                                // This provides zoom, prompt display, and seed regeneration features

                                // Remove all <pic> tags from the message text
                                for (const img of generatedImages) {
                                    const originalTag = typeof img.match?.[0] === 'string' ? img.match[0] : '';
                                    if (!originalTag) {
                                        continue;
                                    }

                                    // If regex transformations are enabled, we need to find the tag in the regex-transformed message
                                    let tagToReplace = originalTag;

                                    if (extension_settings[extensionName].applyRegexTransformations && regexPlacement) {
                                        const usableMessages = context.chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
                                        const indexOf = usableMessages.findIndex(x => x.index === messageIndex);
                                        const depth = messageIndex >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;

                                        const regexedMes = getRegexedString(message.mes, regexPlacement, {
                                            characterOverride: message.name,
                                            isMarkdown: false,
                                            depth: depth,
                                        });

                                        tagToReplace = regexedMes.includes(originalTag)
                                            ? originalTag
                                            : regexedMes.match(new RegExp(`<pic[^>]*prompt="${escapeRegex(img.prompt)}"[^>]*>`, 'g'))?.[0] || originalTag;
                                    }

                                    message.mes = message.mes.replace(tagToReplace, '');
                                }

                                // Add all images to message.extra to use SillyTavern's image viewer
                                if (!message.extra) {
                                    message.extra = {};
                                }
                                if (!Array.isArray(message.extra.image_swipes)) {
                                    message.extra.image_swipes = [];
                                }

                                // Add all images to swipes array
                                for (const img of generatedImages) {
                                    if (!message.extra.image_swipes.includes(img.url)) {
                                        message.extra.image_swipes.push(img.url);
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
                                        message.extra.image_swipes.splice(currentImageIndex, 1);
                                        message.extra.image_swipes.unshift(message.extra.image);
                                        // Update title to match the moved image
                                        const movedImageData = generatedImages.find(img => img.url === message.extra.image);
                                        if (movedImageData) {
                                            message.extra.title = movedImageData.prompt;
                                            console.log(`[${extensionName}] Updated title after moving image to front: ${movedImageData.prompt.substring(0, 50)}...`);
                                        }
                                    } else if (currentImageIndex === 0) {
                                        // Image is already first, but ensure title matches
                                        const currentImageData = generatedImages.find(img => img.url === message.extra.image);
                                        if (currentImageData && message.extra.title !== currentImageData.prompt) {
                                            message.extra.title = currentImageData.prompt;
                                            console.log(`[${extensionName}] Updated title to match current image: ${currentImageData.prompt.substring(0, 50)}...`);
                                        }
                                    }
                                }
                                message.extra.inline_image = true;

                                // CRITICAL: Ensure message.extra.image matches the first item in image_swipes
                                // This is required for SillyTavern's swipe functionality to work correctly
                                // SillyTavern checks if image_swipes.length > 1 and if message.extra.image matches the first item
                                // Also update the title (prompt) to match the current image
                                if (message.extra.image_swipes.length > 0) {
                                    const firstImageUrl = message.extra.image_swipes[0];
                                    if (message.extra.image !== firstImageUrl) {
                                        message.extra.image = firstImageUrl;
                                        // Find and update the prompt for the current image
                                        const currentImageData = generatedImages.find(img => img.url === firstImageUrl);
                                        if (currentImageData) {
                                            message.extra.title = currentImageData.prompt;
                                            console.log(`[${extensionName}] Updated image and title: ${currentImageData.prompt.substring(0, 50)}...`);
                                        }
                                    } else {
                                        // Even if image matches, ensure title is correct
                                        const currentImageData = generatedImages.find(img => img.url === firstImageUrl);
                                        if (currentImageData && message.extra.title !== currentImageData.prompt) {
                                            message.extra.title = currentImageData.prompt;
                                            console.log(`[${extensionName}] Updated title to match current image: ${currentImageData.prompt.substring(0, 50)}...`);
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
                            for (const img of generatedImages) {
                                const originalTag = typeof img.match?.[0] === 'string' ? img.match[0] : '';
                                if (!originalTag) {
                                    continue;
                                }

                                // If regex transformations are enabled, we need to find the tag in the regex-transformed message
                                let tagToReplace = originalTag;

                                if (extension_settings[extensionName].applyRegexTransformations && regexPlacement) {
                                    const usableMessages = context.chat.map((x, index) => ({ message: x, index: index })).filter(x => !x.message.is_system);
                                    const indexOf = usableMessages.findIndex(x => x.index === messageIndex);
                                    const depth = messageIndex >= 0 && indexOf !== -1 ? (usableMessages.length - indexOf - 1) : undefined;

                                    const regexedMes = getRegexedString(message.mes, regexPlacement, {
                                        characterOverride: message.name,
                                        isMarkdown: false,
                                        depth: depth,
                                    });

                                    tagToReplace = regexedMes.includes(originalTag)
                                        ? originalTag
                                        : regexedMes.match(new RegExp(`<pic[^>]*prompt="${escapeRegex(img.prompt)}"[^>]*>`, 'g'))?.[0] || originalTag;
                                }

                                const escapedUrl = escapeHtmlAttribute(img.url);
                                const escapedPrompt = escapeHtmlAttribute(img.prompt);
                                const newImageTag = `<img src="${escapedUrl}" title="${escapedPrompt}" alt="${escapedPrompt}">`;

                                message.mes = message.mes.replace(
                                    tagToReplace,
                                    newImageTag,
                                );
                            }

                            // Update the message display using updateMessageBlock (only once)
                            updateMessageBlock(
                                messageIndex,
                                message,
                            );
                        }

                        await eventSource.emit(
                            event_types.MESSAGE_UPDATED,
                            messageIndex,
                        );

                        // Save the chat to persist the changes
                        await context.saveChat();
                    }
                }
                toastr.success(
                    `${matches.length} images generated successfully`,
                );
            } catch (error) {
                toastr.error(`Image generation error: ${error}`);
                console.error(`[${extensionName}] Image generation error:`, error);
            }
        }, 0); // Prevent blocking UI rendering
    }
}
