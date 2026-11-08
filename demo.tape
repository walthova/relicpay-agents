# Renders the live devnet demo to a video for the narrated submission.
#   vhs demo.tape
Output recordings/relicpay-agents-demo.mp4

Set Shell "zsh"
Set FontSize 20
Set Width 1920
Set Height 1080
Set Padding 40
Set Theme "Dracula"
Set TypingSpeed 45ms

Hide
Type "cd ~/relicpay-agents && clear"
Enter
Sleep 500ms
Show

Sleep 1s
Type "DEMO_PAUSE=11000 ./demo.sh"
Sleep 800ms
Enter
Sleep 135s
Sleep 6s
