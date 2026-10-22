// Generated from plugins/companion-app/remote/remote.js (the web remote's settings
// metadata): curated groups, help text, enum choices, slider bounds and labels.
// Re-run the extraction when those tables change so both remotes stay in step.

export type EnumChoice = [value: string, label: string];
export type RangeBounds = [min: number, max: number, step: number, suffix: string, multiplier: number];

export const GROUPS: [title: string, keys: string[]][] = [
  [
    "EVERYDAY",
    [
      "volume",
      "muted",
      "contentVolume",
      "adVolume",
      "crtEnabled",
      "pictureMode",
      "aspectMode",
      "controls"
    ]
  ],
  [
    "DISPLAY",
    [
      "display",
      "crtIntensity",
      "displayMode",
      "staticEffect",
      "testPattern"
    ]
  ],
  [
    "PROGRAMMING",
    [
      "interstitials",
      "commercials",
      "curationProfiles",
      "tagTaxonomy",
      "trivia",
      "upNext",
      "ticker",
      "reminders",
      "reminderLeadMinutes",
      "stationId",
      "details",
      "vintageAudio",
      "customSounds",
      "timeMachine"
    ]
  ],
  [
    "SYSTEM",
    [
      "autoStandby",
      "network",
      "pinLock",
      "librarySync"
    ]
  ],
  [
    "PLUGINS",
    [
      "pluginSettings"
    ]
  ],
  [
    "UPDATES",
    [
      "updates"
    ]
  ]
];

export const HELP: Record<string, string> = {
  "volume": "Master level for everything the box plays.",
  "muted": "Silences the box without changing the volume level.",
  "contentVolume": "Extra trim applied to shows and movies only.",
  "adVolume": "Extra trim applied to commercials and bumpers only — turn it down if ads are louder than the show.",
  "crtEnabled": "The scanline / curvature / grain picture treatment.",
  "pictureMode": "Overall picture look, the way a TV picture menu works.",
  "aspectMode": "How content that does not match the screen shape is fitted.",
  "theme": "Which era of on-screen guide and menus the box wears.",
  "display.uiScale": "Size of the TV’s own interface, not this page.",
  "updates.strategy": "When a downloaded update is allowed to install.",
  "controls.startupChannel": "Where the TV tunes when it opens: last, first, or a channel number.",
  "controls.entryDelayMs": "How long the box waits after the last digit before tuning.",
  "controls.scanDwellSec": "How long SCAN stays on each channel.",
  "controls.sleepSteps": "The sleep timer lengths, in minutes. The Z key cycles through them.",
  "controls.volumeStepPct": "How much each volume press changes the level.",
  "controls.volumeMaxPct": "The volume keys stop here — handy when the TV is much louder than the PC.",
  "controls.rememberChannelVolume": "Tuning back to a channel returns it to the volume you left it at.",
  "controls.tuneFadeInMs": "Fades the sound in after changing channel, to soften a loud start (0 = off).",
  "controls.sleepFadeOut": "The sound fades over the last 25 seconds of the sleep timer instead of cutting off.",
  "display.guideSlotMinutes": "Length of each guide column in minutes.",
  "display.autoFillWidescreen": "Crop the sides of widescreen content so it fills the picture instead of showing black bars.",
  "display.autoFillMaxCropPct": "The most of the width widescreen fill may crop; wider films keep their bars.",
  "display.removeBakedBars": "Find black bars that are part of the video itself and frame just the picture.",
  "display.logoBugFollowPicture": "Place and size the logo bug against the picture, so it never sits on black bars.",
  "display.logoBugHideOnBreaks": "No logo bug over commercials and bumpers.",
  "display.logoBugHideNumber": "Leave the channel number chip off logos.",
  "display.logoBugVaryWithContent": "Switch logo size with the content’s aspect ratio and resolution instead of one size everywhere.",
  "timeMachine.showTimeShiftBadge": "Show the TIME SHIFT badge while the picture is not live.",
  "commercials.noRepeatCommercials": "Each commercial airs at most once per ad break.",
  "commercials.noRepeatBumpers": "The bump-in and bump-out idents of a break can’t be the same clip.",
  "commercials.noRepeatInterstitials": "Within a flow, a bumper or promo clip airs at most once."
};

export const EXCLUDED = new Set<string>(["channels","plugins","pluginSettingsMeta","lastChannel","theme"]);

export const ENUMS: Record<string, EnumChoice[]> = {
  "pictureMode": [
    [
      "standard",
      "STANDARD"
    ],
    [
      "vivid",
      "VIVID"
    ],
    [
      "cinema",
      "CINEMA"
    ]
  ],
  "aspectMode": [
    [
      "contain",
      "STANDARD / SAFE"
    ],
    [
      "stretch",
      "STRETCH TO FILL"
    ],
    [
      "fill",
      "FILL / CROP"
    ]
  ],
  "displayMode.aspect": [
    [
      "16:9",
      "16:9 WIDESCREEN"
    ],
    [
      "4:3",
      "4:3 CLASSIC"
    ],
    [
      "auto",
      "AUTO"
    ]
  ],
  "displayMode.windowMode": [
    [
      "letterbox",
      "LETTERBOX"
    ],
    [
      "lockWindow",
      "LOCK WINDOW TO ASPECT"
    ]
  ],
  "displayMode.resolution": [
    [
      "native",
      "NATIVE"
    ],
    [
      "sd480",
      "SD 480-LINE"
    ],
    [
      "sd240",
      "SD 240-LINE"
    ],
    [
      "auto",
      "AUTO"
    ]
  ],
  "displayMode.autoPriority": [
    [
      "metadata",
      "FILE RESOLUTION FIRST"
    ],
    [
      "era",
      "ERA TAG FIRST"
    ]
  ],
  "displayMode.uiExtent": [
    [
      "confined",
      "CONFINED TO CONTENT"
    ],
    [
      "fullscreen",
      "EXTEND BEYOND PILLARBOX"
    ]
  ],
  "display.guideSlots": [
    [
      "2",
      "2 / 1 HOUR"
    ],
    [
      "3",
      "3 / 1.5 HOURS"
    ],
    [
      "4",
      "4 / 2 HOURS"
    ]
  ],
  "display.guideSlotMinutes": [
    [
      "15",
      "15 MINUTES"
    ],
    [
      "30",
      "30 MINUTES"
    ],
    [
      "60",
      "1 HOUR"
    ]
  ],
  "controls.tuneFadeInMs": [
    [
      "0",
      "OFF"
    ],
    [
      "400",
      "QUICK (0.4 SEC)"
    ],
    [
      "900",
      "SOFT (0.9 SEC)"
    ],
    [
      "1800",
      "SLOW (1.8 SEC)"
    ]
  ],
  "display.uiScale": [
    [
      "auto",
      "AUTO (RECOMMENDED)"
    ],
    [
      "100",
      "100%"
    ],
    [
      "125",
      "125%"
    ],
    [
      "150",
      "150%"
    ],
    [
      "175",
      "175%"
    ],
    [
      "200",
      "200%"
    ]
  ],
  "display.logoBugMotion": [
    [
      "none",
      "NONE (STATIC)"
    ],
    [
      "pulse",
      "PULSE"
    ],
    [
      "glow",
      "GLOW"
    ],
    [
      "slide-in",
      "SLIDE IN ON TUNE"
    ]
  ],
  "crtIntensity.overlayScope": [
    [
      "video",
      "VIDEO ONLY"
    ],
    [
      "wholeScreen",
      "WHOLE SCREEN"
    ]
  ],
  "screensaver.variant": [
    [
      "auto",
      "AUTO (MATCH THEME)"
    ],
    [
      "bounce",
      "BOUNCING BRAND MARK"
    ],
    [
      "testcard",
      "TEST CARD"
    ],
    [
      "standby",
      "PLEASE STAND BY"
    ],
    [
      "lineup",
      "COMING UP TONIGHT"
    ],
    [
      "diagnostics",
      "SIGNAL DIAGNOSTICS"
    ]
  ],
  "breakingNews.position": [
    [
      "bottom",
      "BOTTOM"
    ],
    [
      "top",
      "TOP"
    ],
    [
      "center",
      "CENTER"
    ]
  ],
  "breakingNews.style": [
    [
      "retro-lower-third",
      "RETRO LOWER THIRD"
    ],
    [
      "full-slate",
      "SPECIAL REPORT SLATE"
    ],
    [
      "ticker-flash",
      "CABLE NEWS FLASH TICKER"
    ],
    [
      "alien-report",
      "ALIEN / SCI-FI BULLETIN"
    ]
  ],
  "eas.signalDegradation.minSeverity": [
    [
      "Minor",
      "MINOR"
    ],
    [
      "Moderate",
      "MODERATE"
    ],
    [
      "Severe",
      "SEVERE"
    ],
    [
      "Extreme",
      "EXTREME"
    ]
  ],
  "pluginSettings.cast-to-tv.mirrorQuality": [
    [
      "1080p60",
      "1080P / 60 FPS"
    ],
    [
      "4k60",
      "4K / 60 FPS"
    ],
    [
      "720p30",
      "720P / 30 FPS"
    ]
  ],
  "updates.strategy": [
    [
      "startup-auto",
      "INSTALL BEFORE APP OPENS"
    ],
    [
      "background-auto",
      "INSTALL WHEN APP QUITS"
    ],
    [
      "background-notify",
      "ASK WHEN READY"
    ],
    [
      "manual",
      "MANUAL"
    ],
    [
      "off",
      "OFF"
    ]
  ]
} as Record<string, EnumChoice[]>;

export const RANGES: Record<string, RangeBounds> = {
  "volume": [
    0,
    100,
    1,
    "%",
    0.01
  ],
  "contentVolume": [
    0,
    100,
    1,
    "%",
    0.01
  ],
  "adVolume": [
    0,
    100,
    1,
    "%",
    0.01
  ],
  "crtIntensity.scanlines": [
    0,
    100,
    1,
    "%",
    1
  ],
  "crtIntensity.vignette": [
    0,
    100,
    1,
    "%",
    1
  ],
  "crtIntensity.grain": [
    0,
    100,
    1,
    "%",
    1
  ],
  "crtIntensity.flicker": [
    0,
    100,
    1,
    "%",
    1
  ],
  "crtIntensity.curvature": [
    0,
    100,
    1,
    "%",
    1
  ],
  "crtIntensity.burnIn": [
    0,
    100,
    1,
    "%",
    1
  ],
  "display.bezelInsetScale": [
    0,
    200,
    10,
    "%",
    1
  ],
  "display.guideOpenCloseAnimMs": [
    80,
    400,
    20,
    "ms",
    1
  ],
  "display.guideCardDuration": [
    1000,
    8000,
    250,
    "ms",
    1
  ],
  "display.hintBarShowDuration": [
    0,
    1500,
    50,
    "ms",
    1
  ],
  "display.hintBarHideDuration": [
    0,
    1500,
    50,
    "ms",
    1
  ],
  "staticEffect.intensity": [
    0,
    100,
    1,
    "%",
    1
  ],
  "staticEffect.durationMs": [
    0,
    1000,
    50,
    "ms",
    1
  ],
  "upNext.duration": [
    3000,
    15000,
    500,
    "ms",
    1
  ],
  "reminderLeadMinutes": [
    1,
    30,
    1,
    " min",
    1
  ],
  "controls.entryDelayMs": [
    200,
    3000,
    100,
    "ms",
    1
  ],
  "controls.scanDwellSec": [
    2,
    60,
    1,
    " sec",
    1
  ],
  "controls.volumeStepPct": [
    1,
    25,
    1,
    "%",
    1
  ],
  "controls.volumeMaxPct": [
    10,
    100,
    5,
    "%",
    1
  ],
  "display.autoFillMaxCropPct": [
    2,
    60,
    1,
    "%",
    1
  ]
} as Record<string, RangeBounds>;

export const LABELS: Record<string, string> = {
  "display.uiScale": "TV INTERFACE SIZE",
  "theme": "TV THEME",
  "controls": "TUNING & CONTROLS",
  "controls.tuneFadeInMs": "FADE IN AFTER TUNING",
  "controls.sleepFadeOut": "FADE OUT BEFORE SLEEP",
  "controls.entryDelayMs": "CHANNEL NUMBER DELAY",
  "controls.scanDwellSec": "SCAN STAYS ON EACH CHANNEL",
  "controls.volumeStepPct": "VOLUME STEP",
  "controls.volumeMaxPct": "MAXIMUM VOLUME",
  "display.guideSlotMinutes": "GUIDE COLUMN LENGTH",
  "display.autoFillWidescreen": "FILL WIDESCREEN CONTENT",
  "display.removeBakedBars": "REMOVE BAKED-IN BLACK BARS",
  "display.logoBugFollowPicture": "KEEP THE LOGO BUG ON THE PICTURE"
};
