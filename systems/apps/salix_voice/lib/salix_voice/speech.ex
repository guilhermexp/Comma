defmodule SalixVoice.Speech do
  @moduledoc """
  Split Router text into GPT-Live append chunks (docs/messaging-voice.md).

  Each `session.*.append` takes at most 500 tokens. A chunk holds whole
  sentences up to 1,800 characters and about 480 estimated tokens (ASCII text
  counts four characters per token, other characters one each, so CJK text is
  not undercounted). A longer sentence splits at spaces, then hard.
  `max_bytes:` also bounds each chunk's UTF-8 size, so a chunk is never cut
  again on the way to the model.
  """

  @max_chars 1_800
  @max_tokens 480

  @doc "Chunks of `text` in order; empty text gives `[]`."
  @spec chunks(String.t(), keyword()) :: [String.t()]
  def chunks(text, opts \\ []) when is_binary(text) do
    max_bytes = Keyword.get(opts, :max_bytes)

    text
    |> String.trim()
    |> SalixVoice.Transcript.sentences()
    |> Enum.flat_map(&split_long(&1, max_bytes))
    |> Enum.reduce([], fn sentence, acc ->
      case acc do
        [current | rest] ->
          candidate = current <> " " <> sentence
          if fits?(candidate, max_bytes), do: [candidate | rest], else: [sentence | acc]

        [] ->
          [sentence]
      end
    end)
    |> Enum.reverse()
  end

  @doc "Rough token estimate used for the 500-token append limit."
  def estimate_tokens(text) do
    {ascii, other} =
      text
      |> String.to_charlist()
      |> Enum.reduce({0, 0}, fn char, {ascii, other} ->
        if char < 128, do: {ascii + 1, other}, else: {ascii, other + 1}
      end)

    div(ascii + 3, 4) + other
  end

  defp fits?(text, max_bytes) do
    String.length(text) <= @max_chars and estimate_tokens(text) <= @max_tokens and
      (max_bytes == nil or byte_size(text) <= max_bytes)
  end

  defp split_long(sentence, max_bytes) do
    if fits?(sentence, max_bytes),
      do: [sentence],
      else: split_words(String.split(sentence, ~r/\s+/u), [], max_bytes)
  end

  defp split_words([], acc, _max_bytes), do: Enum.reverse(acc)

  defp split_words([word | rest], acc, max_bytes) do
    cond do
      not fits?(word, max_bytes) ->
        {head, tail} = hard_split(word, max_bytes)
        split_words([tail | rest], [head | acc], max_bytes)

      acc != [] and fits?(hd(acc) <> " " <> word, max_bytes) ->
        split_words(rest, [hd(acc) <> " " <> word | tl(acc)], max_bytes)

      true ->
        split_words(rest, [word | acc], max_bytes)
    end
  end

  # Take graphemes while the running character, token and byte counts fit.
  defp hard_split(word, max_bytes) do
    {head, tail} = take_fitting(String.graphemes(word), [], {0, 0, 0, 0}, max_bytes)
    {Enum.join(head), Enum.join(tail)}
  end

  defp take_fitting([grapheme | rest] = all, acc, {chars, ascii, other, bytes}, max_bytes) do
    {ascii, other} =
      if byte_size(grapheme) == 1, do: {ascii + 1, other}, else: {ascii, other + 1}

    bytes = bytes + byte_size(grapheme)

    if acc != [] and
         (chars + 1 > @max_chars or div(ascii + 3, 4) + other > @max_tokens or
            (max_bytes != nil and bytes > max_bytes)),
       do: {Enum.reverse(acc), all},
       else: take_fitting(rest, [grapheme | acc], {chars + 1, ascii, other, bytes}, max_bytes)
  end

  defp take_fitting([], acc, _counts, _max_bytes), do: {Enum.reverse(acc), []}
end
