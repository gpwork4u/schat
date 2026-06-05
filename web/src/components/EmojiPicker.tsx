import { useMemo } from 'react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

export interface CustomEmoji { shortcode: string; url: string; }

interface Props {
  customEmojis: CustomEmoji[];
  /** Called with a value ready for the `react` op: a unicode char (native)
   *  or a `:shortcode:` (custom). */
  onPick: (emoji: string) => void;
}

// emoji-mart gives us the full Slack-style picker: every unicode emoji,
// categories, search, skin tones, frequently-used — plus our Google Chat
// custom emojis fed through its `custom` category prop.
export default function EmojiPicker({ customEmojis, onPick }: Props) {
  const custom = useMemo(() => {
    if (!customEmojis.length) return undefined;
    return [
      {
        id: 'gchat',
        name: '自訂表情',
        emojis: customEmojis
          .filter((e) => e.url)
          .map((e) => {
            const id = e.shortcode.replace(/:/g, '');
            return { id, name: id, keywords: [id], skins: [{ src: e.url }] };
          }),
      },
    ];
  }, [customEmojis]);

  return (
    <Picker
      data={data}
      custom={custom}
      theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}
      locale="zh"
      previewPosition="none"
      skinTonePosition="search"
      searchPosition="sticky"
      navPosition="top"
      perLine={9}
      emojiSize={22}
      emojiButtonSize={32}
      maxFrequentRows={2}
      onEmojiSelect={(e: any) => {
        // native unicode emoji → send the char; custom (has src/no native) →
        // send :shortcode: which the react op resolves against the catalog.
        const value = e?.native || (e?.id ? `:${e.id}:` : '');
        if (value) onPick(value);
      }}
    />
  );
}
