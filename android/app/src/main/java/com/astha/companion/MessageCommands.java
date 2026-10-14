package com.astha.companion;

import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a spoken answer means while ASTHA is helping with a message on a locked phone, and
 * what ASTHA says at each step. Plain Java, so it is unit tested without a device.
 *
 * The rule that matters: in the confirm step only a clear yes sends. Silence, noise, an
 * unclear answer or anything else means "do not send".
 */
final class MessageCommands {
    enum Kind { REPLY, ASK_TEXT, TEXT, IGNORE, REPEAT, YES, NO, CHANGE, NOTHING, UNKNOWN }

    static final class Command {
        final Kind kind;
        final String text;

        Command(Kind kind, String text) {
            this.kind = kind;
            this.text = text;
        }
    }

    static final String DECIDE = "decide", COMPOSE = "compose", CONFIRM = "confirm";
    static final int MAX_REPLY = 500;
    // A word ends at the end of the phrase or at a space or punctuation, in either script.
    private static final String END = "(?=$|[\\s,.!?।])";
    private static final int FLAGS = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;
    private static final Pattern WAKE = Pattern.compile("^(?:hey\\s+)?astha[,!\\s]*|^আস্থা[,।\\s]*", FLAGS);
    private static final Pattern YES = Pattern.compile("^(?:(?:yes|yeah|yep|sure|ok|okay)(?:[,\\s]+send it)?|send|send it|go ahead|do it|হ্যাঁ(?:[,\\s]+(?:পাঠাও|পাঠিয়ে দাও))?|হুম|জি|জ্বি|পাঠাও|পাঠিয়ে দাও|ঠিক আছে)$", FLAGS);
    private static final Pattern CHANGE = Pattern.compile("^(?:change|change it|edit|বদলাও)" + END, FLAGS);
    private static final Pattern CANCEL = Pattern.compile("^(?:cancel|never mind|forget it|ignore|skip|stop|no|nope|leave it|dismiss|বাতিল|থাক|বাদ দাও|থামো|না)" + END, FLAGS);
    private static final Pattern REPEAT = Pattern.compile("^(?:repeat|read it again|read that again|say that again|again|আবার পড়ো|আবার বলো|আবার)" + END, FLAGS);
    private static final Pattern REPLY = Pattern.compile("^(?:reply|answer|respond|tell (?:him|her|them))(?:\\s+(?:to (?:him|her|them|it)|with|saying|that|back))*[:,]?\\s*(.*)$", FLAGS);
    private static final Pattern REPLY_BN = Pattern.compile("^(?:উত্তর দাও|রিপ্লাই দাও|উত্তর|রিপ্লাই|বলো)[:,]?\\s*(.*)$", FLAGS);

    private MessageCommands() {}

    static boolean shouldListen(String utterance, int turn, boolean hasCurrent, boolean completed) {
        return completed && hasCurrent && (turn + ":listen").equals(utterance);
    }

    static boolean mayAnswer(boolean appVisible, int heardFor, int turn, boolean hasCurrent) {
        return !appVisible && heardFor == turn && hasCurrent;
    }

    private static String bounded(String text) {
        String clean = text.replaceAll("[\\p{Cntrl}]", " ").replaceAll("\\s+", " ").trim();
        return clean.length() > MAX_REPLY ? clean.substring(0, MAX_REPLY) : clean;
    }

    static Command parse(String heard, String stage) {
        // Recognizers may return composed or decomposed Bangla letters; compare one form.
        String normal = Normalizer.normalize(heard == null ? "" : heard.trim(), Normalizer.Form.NFC);
        String said = bounded(WAKE.matcher(normal).replaceFirst(""));
        String q = said.toLowerCase(Locale.ROOT).replaceAll("[.!?।\\s]+$", "");
        if (q.isEmpty()) return new Command(Kind.NOTHING, "");
        if (CONFIRM.equals(stage)) {
            if (YES.matcher(q).matches()) return new Command(Kind.YES, "");
            if (CHANGE.matcher(q).find()) return new Command(Kind.CHANGE, "");
            return new Command(Kind.NO, "");
        }
        if (COMPOSE.equals(stage)) {
            if (CANCEL.matcher(q).find()) return new Command(Kind.IGNORE, "");
            return new Command(Kind.TEXT, said);
        }
        if (CANCEL.matcher(q).find()) return new Command(Kind.IGNORE, "");
        if (REPEAT.matcher(q).find()) return new Command(Kind.REPEAT, "");
        Matcher reply = REPLY.matcher(said);
        if (!reply.find()) {
            reply = REPLY_BN.matcher(said);
            if (!reply.find()) return new Command(Kind.UNKNOWN, "");
        }
        String words = bounded(reply.group(1));
        return words.isEmpty() ? new Command(Kind.ASK_TEXT, "") : new Command(Kind.REPLY, words);
    }

    // ---- What ASTHA says ----------------------------------------------------------------

    static String announce(boolean bangla, String app, String sender, String text, boolean canReply) {
        if (bangla) {
            return (app.isEmpty() ? "" : app + "-এ ") + sender + " নতুন বার্তা পাঠিয়েছেন: " + ended(text, "।")
                + (canReply ? " " + prompt(true) : "");
        }
        return "New message from " + sender + (app.isEmpty() ? "" : " in " + app) + ": " + ended(text, ".") + (canReply ? " " + prompt(false) : "");
    }

    // A pause after the message, without doubling the sender's own full stop or question mark.
    private static String ended(String text, String stop) {
        return text.matches("(?s).*[.!?।]$") ? text : text + stop;
    }

    static String prompt(boolean bangla) {
        return bangla
            ? "উত্তর দিতে বলুন উত্তর দাও এবং আপনার কথা, অথবা বলুন বাদ দাও।"
            : "Say reply and your answer, or say ignore.";
    }

    static String askText(boolean bangla, String sender) {
        return bangla ? sender + "-কে কী বলব?" : "What should I say to " + sender + "?";
    }

    static String confirm(boolean bangla, String sender, String draft) {
        return bangla
            ? sender + "-কে পাঠাব: " + draft + "। পাঠাতে বলুন হ্যাঁ, না হলে না।"
            : "I will send: " + draft + ". To " + sender + ". Say yes to send it, or no.";
    }

    static String sent(boolean bangla, String sender) {
        return bangla ? sender + "-কে পাঠানো হয়েছে।" : "Sent to " + sender + ".";
    }

    static String notSent(boolean bangla) {
        return bangla ? "ঠিক আছে, কিছুই পাঠানো হয়নি।" : "Okay, nothing was sent.";
    }

    static String failed(boolean bangla) {
        return bangla ? "পাঠাতে পারিনি। কিছুই পাঠানো হয়নি।" : "I could not send it. Nothing was sent.";
    }
}
