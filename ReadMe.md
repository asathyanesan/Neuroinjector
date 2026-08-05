# **UD Neuroinjector**

![](/readme_images/injector.png) 

> [Arduino Uno Wiring Diagram - Tinkercad](https://www.tinkercad.com/things/jYT1CjaT22d-november-2024-injector-control?sharecode=C9nnUTwrhzWC7_K2SykUDTFZvW9YDyTTlg0h3D3HC3E)
![](/diagrams/injector_arduino.png) ![](/readme_images/controller_wiring.png)

The UD Neuroinjector - a completely automated stereotaxic injector is constructed with 3D printed housings, a Nema 8 stepper, an  Arduino starter kit, and various hardware. A full parts list is available as a part of this package.

### Purpose
Stereotaxic injections of drugs or biologics into specific regions of the rodent brain are a very common procedure in modern neuroscience. Micro- or nanoliter injections must controlled precisely to avoid damage to brain tissue. Automated stereotaxic injectors are the ideal solution for this procedure, however, commercial injectors are very expensive (>4000 USD). We designed the UD Neuroinjector: an open-source automated stereotaxic injector using readily available, cost-efficient components and an Arduino microcontroller.

### Repository Layout
This repository follows a simple structure.
  - The `diagrams` folder holds diagrams for wiring the arduino control board to the motor and switches. 
  - The `documentation` folder holds the spec sheet for the NEMA 8 Stepper motor as well as the assembly procedure for the automated injector.
  - The `injector_control_stepper` folder contains the code used to program the arduino.
  - The `models` folder contains the CAD files used to design and print the injector housing
  - The `readme_images` folder contains the images shown below.
  - The `webapp` folder contains a static syringe configurator web app (see below).
  - The `react-app` folder contains the experimental AI Assistant web app (see below), built
    into the repo-root `assistant` folder for GitHub Pages.

### Syringe Configurator Web App
`injector_control.ino` supports Hamilton 7000-series microliter syringes, and previously
only shipped with the 7000.5 (0.5 µL) and 7001 (1 µL) models built in. The [`webapp`](/webapp)
folder contains a static, client-side-only web app that lets you pick from a database of 
Hamilton syringe models built from Hamilton's official spec sheets, add a custom syringe by
volume/stroke length, and download a ready-to-flash `injector_control.ino` generated from your selection. 
You can access the Syringe Configurator Web App here: [https://asathyanesan.github.io/Neuroinjector/webapp/](https://asathyanesan.github.io/Neuroinjector/webapp/)

**Note on Neuros syringes:** Hamilton Neuros syringes (part numbers 65457/65458/65459) share
the same 7.8 mm barrel OD as the supported Knurled Hub (KH) syringes, but have been confirmed
by physical test-fit to NOT fit the current 3D-printed housing/retention mechanism. Neuros
syringe support is planned for a future Neuroinjector release with an updated hardware build.

### AI Assistant (Experimental)
The [`react-app`](/react-app) folder contains an experimental AI-powered assistant modeled
after [ds-research-tool-test](https://github.com/asathyanesan/ds-research-tool-test). It's a
Vite + React chat app that grounds its answers in this repo's own data (hardware/firmware
facts, the Hamilton syringe compatibility table, and a corpus of rodent stereotaxic injection
literature) using simple client-side keyword matching — no vector database or embeddings
required. It reuses the same Cloudflare Worker LLM proxy deployed for `ds-research-tool-test`
(no separate worker needed — see [`react-app/README.md`](/react-app/README.md)).

It's meant to help with two things:
1. Troubleshooting the Neuroinjector hardware/firmware and syringe compatibility.
2. Designing/troubleshooting rodent stereotaxic microinjection procedures (coordinates,
   volumes, flow rates), grounded in indexed literature — **not** a substitute for
   IACUC-approved protocols or veterinary guidance.

Built and published to the repo-root `assistant/` folder via `npm run deploy` (see
[`react-app/README.md`](/react-app/README.md)), the same "deploy from branch" mechanism
already used for `webapp/`. You can access it here:
[https://asathyanesan.github.io/Neuroinjector/assistant/](https://asathyanesan.github.io/Neuroinjector/assistant/)

> Note: `assistant-legacy/` (a Python/LangChain-based prototype of this same idea) predates the
> `react-app` approach above and is currently unused/superseded, kept only for reference.


### Programming Arduino Using the Arduino IDE
The most user-friendly way to program and communicate with an Arduino is through the Arduino IDE. The latest IDE can be collected from [https://www.arduino.cc/en/software](https://www.arduino.cc/en/software). 

...

### Simply Executing Serial Communication in VS Code 
Reilly Downing - September 2024

This documentation will detail how to install Microsoft Visual Studio Code and a Serial Monitor extension to simply establish serial communication with the injector.

1. Retrieve the appropriate installer for your operating system from [https://code.visualstudio.com/download](https://code.visualstudio.com/download)   
2. Run the installer, the default location is fine. Changing the location will not affect this process.  
3. Open VS Code  
![](/readme_images/vs_home.png)  
4. Open the extensions menu ( ctrl \+ shift \+ x ) and search for Serial Monitor 
5. Select the extension marked as produced by Microsoft, then select install
6. At the top of the window, select Terminal > New Terminal
![](/readme_images/vs_new-terminal.png)  
7. In the new partition at the bottom of the window, select SERIAL MONITOR
8. With the device plugged in, ensure that the Port drop down has the correct port selected, ensure a buad rate of 115200, and select Start Monitoring.

If a message from the device is not displayed, press the reset button (physical button in corner of expansion board) on the Arduino controller.  
![](/readme_images/terminal_view.png)  
To send messages and interact with the device, click into the bar at the bottom of the Serial Monitor window. It should read `Type in a message to send to the serial port.` while waiting for an input.


### Programming Arduino in VS Code
Reilly Downing \- April 2024

This documentation will detail how to install Microsoft Visual Studio Code, and how to use the Arduino extension to establish serial communication with the injector.

1. Retrieve the appropriate installer for your operating system from [https://code.visualstudio.com/download](https://code.visualstudio.com/download)   
2. Run the installer, the default location is fine. Changing the location will not affect this process.  
3. Open VS Code  
4. Open the extensions menu ( ctrl \+ shift \+ x ) and search for Arduino  
5. Select the extension marked as produced by Microsoft, then select install  
6. If prompted, select to use Arduino CLI  
   1. If not prompted, open settings ( ctrl \+ , ), type ‘arduino’ into the search bar  
   2. Scroll down to see Arduino: **Use Arduino Cli**  
   3. Select the box to enable this

![](/readme_images/command_path.png)

7. Restart the IDE (VS Code)  
8. Ensure the device is plugged into the computer using USB  
   1. Open the command search ( ctrl \+ shift \+ p )  
   2. Begin to type Arduino: Select Serial Port, click the command  
   3. Select the port with Uno R3 or USB Serial Device from the list  
      1. For Error regarding Serial Monitor Extension, return to step 6, double check the CLI use in settings, and restart the IDE, ensuring it has been stopped in task manager before reopening  
      2. if the error pops up after this, simply ignore it and run Arduino: Select Serial Port again  
9. The arduino.json configuration file should be created inside the .vscode directory of the current workspace, ensure this file exists or create it.
   1. Edit the json object to point to the injector control program, it should have the following form:
   ```json
   {
    "board": "arduino:avr:uno",
    "sketch": "injector_control_stepper\\injector_control.ino",
    "port": "COM4"
   }
   ```
10. Open injector_control.ino and select the verify then upload options from the arduino extensions up in the top right of the editor. On errors regarding missing libraries, ensure that the accel_stepper library is included in your arduino libraries path.

![](/readme_images/upload_code.png)
