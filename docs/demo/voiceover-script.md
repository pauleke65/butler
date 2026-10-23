# Butler walkthrough: voice-over script

You read 21 short clips; Butler's replies stay in its own voice (Polly "Ruth"). Reading time is about 1 minute 30 seconds; with Butler's replies the finished video lands just under 3 minutes, so keep a steady pace.

## How to record

1. Use a quiet room, your phone's voice recorder, about a hand's width from your mouth. Avoid echo-heavy rooms (bathrooms, empty halls).
2. Read the clips **in order**, in one recording. **Don't read the numbers** or the notes in *italics*.
3. **Pause for two full seconds** after each clip. The pauses are how I cut your recording into clips.
4. If you fluff a line, pause, then read that **whole** clip again. I keep the last take.
5. Talk the way you'd show a friend something you built: relaxed, smiling, a little slower than normal conversation. It's fine to sound like yourself; it doesn't have to be perfect.
6. Lines marked *to the Echo* are you speaking to the device: say them the way you'd talk to Alexa at home.
7. Send the file as it comes off your phone (m4a, mp3 or wav are all fine).

Pronunciation: **AgentCore** = "agent core".

## The clips

**1.** Hi, I'm Paul, and this is Butler: an Alexa+ add-on that handles everyday stuff for you. And when you correct it, that becomes a rule the AI can't break.

**2.** It's running on an Echo Show in my simulator, talking to the real backend on AWS. The Black Box on the right logs every gateway decision.

**3.** I don't give Butler commands. I just tell it what's going on.

**4.** *(to the Echo)* Tell Butler six friends from the dinner crew are coming over Friday at seven.

**5.** And it gets to work.

**6.** It won't interrupt me. It waits until I check in.

**7.** *(to the Echo)* How's Friday looking?

**8.** It needs me to pick a cleaner. I'll go with BrightHome.

**9.** That tap goes through a separate approval path. The AI can't approve itself.

**10.** Everything it does has a receipt.

**11.** *(to the Echo)* Why did you buy the drinks?

**12.** What it knew, what it turned down, and the rule that let it go ahead.

**13.** *(to the Echo)* Don't buy drinks without asking me.

**14.** *(to the Echo)* Yes.

**15.** The AI only picks a rule template. Regular code turns it into a policy the gateway enforces. There's the new rule.

**16.** *(to the Echo)* I'm travelling Thursday to Sunday. My parents are staying at the house.

**17.** Butler tried to buy drinks for my parents, and the gateway blocked it, outside the AI, before anything was spent.

**18.** *(to the Echo)* Anything you need from me?

**19.** So instead of buying, it asks me first.

**20.** *(to the Echo)* What did you do this week that I might disagree with?

**21.** That's Butler, built on Amazon Bedrock AgentCore. Thanks for watching!

## Where each clip plays

| Clip | On screen |
|---|---|
| 1 | Title card |
| 2 | Whole simulator: Echo Show on the left, Black Box on the right |
| 3–5 | Camera on the Echo: you describe the dinner, Butler answers and the plan appears |
| 6–9 | You ask about Friday, the cleaner carousel appears, BrightHome gets tapped, the approval lands |
| 10–12 | The receipt for the drinks, with the "why" open |
| 13–15 | You correct Butler, then the camera moves to the Black Box as the new rule goes live |
| 16–17 | The travel plan, then the camera moves in on the Black Box as the gateway denies the drinks |
| 18–19 | Back on the Echo: Butler asks for your OK |
| 20 | The "you might disagree with" cards |
| 21 | Closing card |
