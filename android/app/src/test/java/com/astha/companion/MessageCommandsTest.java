package com.astha.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.text.Normalizer;

import org.junit.Test;

/** The locked-phone assistant: what a spoken answer means, and that only a clear yes sends. */
public class MessageCommandsTest {
    private static MessageCommands.Kind kind(String heard, String stage) {
        return MessageCommands.parse(heard, stage).kind;
    }

    @Test
    public void onlyAClearYesSendsAtTheConfirmStep() {
        for (String yes : new String[] { "yes", "Yes.", "yeah send it", "okay", "Astha, yes", "হ্যাঁ", "হ্যাঁ।", "পাঠাও", "ঠিক আছে" }) {
            assertEquals(yes, MessageCommands.Kind.YES, kind(yes, MessageCommands.CONFIRM));
        }
        for (String other : new String[] { "", "   ", "no", "না", "yesterday was fine", "what", "noise", "cancel", "maybe" }) {
            MessageCommands.Kind result = kind(other, MessageCommands.CONFIRM);
            assertTrue(other, result == MessageCommands.Kind.NO || result == MessageCommands.Kind.NOTHING);
        }
        assertEquals(MessageCommands.Kind.CHANGE, kind("change it", MessageCommands.CONFIRM));
        assertEquals(MessageCommands.Kind.CHANGE, kind("বদলাও", MessageCommands.CONFIRM));
        assertEquals(MessageCommands.Kind.NOTHING, kind(null, MessageCommands.CONFIRM));
    }

    @Test
    public void aReplyWithWordsCarriesThemAndAReplyWithoutAsksForThem() {
        MessageCommands.Command reply = MessageCommands.parse("reply I will be there at five", MessageCommands.DECIDE);
        assertEquals(MessageCommands.Kind.REPLY, reply.kind);
        assertEquals("I will be there at five", reply.text);
        assertEquals("on my way", MessageCommands.parse("Astha, tell her that on my way", MessageCommands.DECIDE).text);
        assertEquals(MessageCommands.Kind.ASK_TEXT, kind("reply", MessageCommands.DECIDE));
        assertEquals(MessageCommands.Kind.ASK_TEXT, kind("উত্তর দাও", MessageCommands.DECIDE));
        MessageCommands.Command bangla = MessageCommands.parse("উত্তর দাও আমি আসছি", MessageCommands.DECIDE);
        assertEquals(MessageCommands.Kind.REPLY, bangla.kind);
        assertEquals("আমি আসছি", bangla.text);
    }

    @Test
    public void ignoreRepeatAndUnclearAnswersAreRecognised() {
        assertEquals(MessageCommands.Kind.IGNORE, kind("ignore", MessageCommands.DECIDE));
        assertEquals(MessageCommands.Kind.IGNORE, kind("বাদ দাও", MessageCommands.DECIDE));
        assertEquals(MessageCommands.Kind.REPEAT, kind("read it again", MessageCommands.DECIDE));
        assertEquals(MessageCommands.Kind.REPEAT, kind("আবার পড়ো", MessageCommands.DECIDE));
        assertEquals(MessageCommands.Kind.UNKNOWN, kind("what's the weather", MessageCommands.DECIDE));
        assertEquals(MessageCommands.Kind.NOTHING, kind("", MessageCommands.DECIDE));
        // "no" starting a longer word is not a refusal, and "reply" must start the request.
        assertEquals(MessageCommands.Kind.UNKNOWN, kind("nothing much", MessageCommands.DECIDE));
        assertEquals(MessageCommands.Kind.UNKNOWN, kind("please don't reply", MessageCommands.DECIDE));
    }

    @Test
    public void composedWordsAreTakenAsTheReplyUnlessTheyCancel() {
        MessageCommands.Command words = MessageCommands.parse("Running late, start without me.", MessageCommands.COMPOSE);
        assertEquals(MessageCommands.Kind.TEXT, words.kind);
        assertEquals("Running late, start without me.", words.text);
        assertEquals(MessageCommands.Kind.IGNORE, kind("cancel", MessageCommands.COMPOSE));
        assertEquals(MessageCommands.Kind.IGNORE, kind("থাক", MessageCommands.COMPOSE));
        assertEquals(MessageCommands.Kind.NOTHING, kind("", MessageCommands.COMPOSE));
    }

    @Test
    public void decomposedBanglaFromARecognizerIsUnderstood() {
        String decomposed = Normalizer.normalize("হ্যাঁ", Normalizer.Form.NFD);
        assertEquals(MessageCommands.Kind.YES, kind(decomposed, MessageCommands.CONFIRM));
        // Some recognizers return the single code point U+09DF, which NFC splits in two.
        String precomposed = "\u09AA\u09BE\u09A0\u09BF\u09DF\u09C7 \u09A6\u09BE\u0993";
        assertEquals(MessageCommands.Kind.YES, kind(precomposed, MessageCommands.CONFIRM));
    }

    @Test
    public void repliesAreBoundedAndCleaned() {
        StringBuilder longWords = new StringBuilder("reply ");
        for (int i = 0; i < 200; i++) longWords.append("word ");
        String text = MessageCommands.parse(longWords.toString(), MessageCommands.DECIDE).text;
        assertTrue(text.length() <= MessageCommands.MAX_REPLY);
        assertFalse(MessageCommands.parse("reply hi\u0000there", MessageCommands.DECIDE).text.contains("\u0000"));
    }

    @Test
    public void spokenPhrasesNameTheSenderAndTheWords() {
        assertEquals("New message from Rina in Messenger: Are you coming? Say reply and your answer, or say ignore.",
            MessageCommands.announce(false, "Messenger", "Rina", "Are you coming?", true));
        assertFalse(MessageCommands.announce(false, "", "Rina", "Hi", false).contains("reply"));
        assertTrue(MessageCommands.confirm(false, "Rina", "On my way").contains("On my way"));
        assertTrue(MessageCommands.confirm(true, "Rina", "আসছি").contains("হ্যাঁ"));
        assertTrue(MessageCommands.notSent(false).contains("nothing was sent"));
        assertTrue(MessageCommands.failed(true).contains("কিছুই"));
        assertTrue(MessageCommands.announce(false, "", "Rina", "Hi", false).endsWith("Hi."));
    }
}
