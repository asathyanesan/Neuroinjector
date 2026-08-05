/* Injector Control
  Reilly Downing - Owen Beer, Megan LaBelle, Naeamah Rabeea
  April 2024

  This program establishes serial control over an automated microinjector.
  Modified July 2026 to include an active 1 Hz countdown and percentage progress monitor.
*/

#include <Stepper.h>
#include <AccelStepper.h>
 
AccelStepper injector(AccelStepper::DRIVER, 8, 9); // Defaults to AccelStepper::FULL4WIRE (4 pins) on 2, 3, 4, 5

long steps = 0;
int stepsprev = 1600;
bool restart = false;
bool safety = false;

// SYRINGE_CONSTANTS_START -- generated/edited by the syringe configurator web app (see /webapp)
const float HAM_7000_5_DIV = 25.0 / 3.0; // Hamilton 7000.5, 0.5 uL
const float HAM_7001_DIV = 50.0 / 3.0; // Hamilton 7001, 1 uL
// SYRINGE_CONSTANTS_END

float syringe_div;

// given lead/pitch of our rod (mm/rotation)
float lead = 0.6096;

void stop() {
  injector.stop();
  injector.setCurrentPosition(0);
  Serial.println(F("Stopped\n"));
}

long getsteps(float vol) {
  return (vol * stepsprev) / (syringe_div * lead );
}

float getsteppsec(float flow) {
  float lin_speed = flow / syringe_div;
  float rpm = lin_speed / lead; // handy for stepper motors
  return rpm / 60.0 * stepsprev;
}

void start_injector(bool inject) {
  float flow, vol;

  if (inject) {
    Serial.println(F("**Injection Mode**")); 
  }
  else {
    Serial.println(F("**Extraction Mode**"));
  }
  
  Serial.println(F("Input Flow Rate (nL/min):")); 
  while (true) {
    if (Serial.available()) {                            
      flow = Serial.parseFloat(); //returns a zero if it times out or no valid ints are available
      if (flow < 0.1 || flow > 1000) {
        Serial.println(F("Flow rate must be between 0.1 and 1000 nL/min\nInput Flow Rate (nL/min):"));
      } else {break;}
    }
  }
 
  Serial.println(F("\nInput Volume (nL):")); 
  while (true) {
    if (Serial.available()) {                            
      vol = Serial.parseFloat(); //returns a zero if it times out or no valid ints are available
      if (vol < 0.1 || vol > 500) {
        Serial.println(F("Volume must be between 0.1 and 500 nL\nInput Volume (nL):"));
      } else {break;}
    }
  }
  
  float steppsec = getsteppsec(flow);
  steps = getsteps(vol);

  //Debug Info
  Serial.print(F("flow rate: \t"));
  Serial.println(flow);
  Serial.print(F("vol: \t\t"));
  Serial.println(vol); 
  Serial.print(F("Steps/sec: \t"));
  Serial.println(steppsec);
  Serial.print(F("Steps: \t\t"));
  Serial.println(steps);

  Serial.println(F("\nReady. Hit Physical Button to begin.")); 
  
  while (true) {
    if (digitalRead(13)==HIGH) {        // Hangs until button is pressed
      while (digitalRead(13)==HIGH){
            // Hangs until button is released
      }
      break;
    }
  }

  if (inject) {
    Serial.println(F("Injecting..."));
    injector.move(-steps);
  }
  else {
    Serial.println(F("Extracting..."));
    injector.move(steps);
  }
  injector.setSpeed(steppsec);

  // --- COUNTDOWN & PROGRESS INITIALIZATION ---
  unsigned long totalDurationSeconds = round((float)steps / steppsec);
  unsigned long injectionStart = millis();
  unsigned long lastTimerPrint = 0;
  
  Serial.print(F("[TIMER] Total Expected Profile Time: "));
  Serial.print(totalDurationSeconds);
  Serial.println(F(" seconds."));
  
  while( (digitalRead(12)==LOW || !inject) ) {   
    injector.runSpeedToPosition();

    // --- NON-BLOCKING 1 HZ PROGRESS OUTPUT ---
    unsigned long currentMillis = millis();
    if (currentMillis - lastTimerPrint >= 1000) {
      lastTimerPrint = currentMillis;
      
      unsigned long secondsElapsed = (currentMillis - injectionStart) / 1000;
      long secondsRemaining = (long)totalDurationSeconds - (long)secondsElapsed;
      
      if (secondsRemaining < 0) {
        secondsRemaining = 0;
      }
      
      // Calculate percentage complete securely without division-by-zero risks
      int progressPercent = 0;
      if (totalDurationSeconds > 0) {
        progressPercent = (secondsElapsed * 100) / totalDurationSeconds;
        if (progressPercent > 100) {
          progressPercent = 100;
        }
      }
      
      Serial.print(F("[TIMER] Time Remaining: "));
      Serial.print(secondsRemaining);
      Serial.print(F(" seconds ("));
      Serial.print(progressPercent);
      Serial.println(F("% Complete)"));
    }

    // --- PAUSE LOGIC WITH TIME COMPENSATION ---
    if(digitalRead(13)==HIGH) {
      Serial.println(F("**\n**PAUSING - Press Button Again to Resume, Press Reset to Stop\n**\n"));
      unsigned long pauseStart = millis(); 
      
      while(true){
        delay(1);
        if (digitalRead(13)==LOW) {   
          delay(1);     
          while (digitalRead(13)==LOW){/* Hangs until button is Pressed*/}
          while(digitalRead(13)==HIGH){/* Hangs until button is released*/}
          delay(1);
          
          unsigned long pauseDuration = millis() - pauseStart;
          injectionStart += pauseDuration;
          lastTimerPrint += pauseDuration;
          
          Serial.println(F("**\n**RESUMING \n**\n"));
          break;
        }
      }
    }

    if (injector.currentPosition()==injector.targetPosition()) {
        injector.setCurrentPosition(0);
        restart = true;
        break;
    }
  }
  
  if (!restart) {
    injector.setCurrentPosition(0);
    safety = true;
  }

  steps = 0;
}

int xValue = 0; 
int yValue = 0; 
int upthresh = 640;
int downthresh = 400;

void manual() {
  Serial.println(F("Begin Manual Control. Press the Physical Button to exit."));
  while(digitalRead(13)==LOW) {
    xValue = analogRead(A2);

    if (xValue > upthresh) {
      float steppsec = getsteppsec(600);
      steps = getsteps(500);
      injector.move(-steps);
      injector.setSpeed(steppsec);

      while(digitalRead(12)==LOW && xValue > upthresh) {
        xValue = analogRead(A2);
        injector.runSpeedToPosition();
      }
    }
    if (xValue < downthresh) {
      float steppsec = getsteppsec(600);
      steps = getsteps(500);
      injector.move(steps);
      injector.setSpeed(steppsec);

      while(xValue < downthresh) {
        xValue = analogRead(A2);
        injector.runSpeedToPosition();
      }
    }
  }
  injector.setCurrentPosition(0);
  restart = true;
}

void select_syringe() {
  bool selected = false;
  Serial.println(F("Input the number associated with the desired syringe: "));
  // SYRINGE_MENU_START -- generated/edited by the syringe configurator web app (see /webapp)
  Serial.println(F("`1` - Hamilton 7000.5 0.5uL"));
  Serial.println(F("`2` - Hamilton 7001 1uL"));
  Serial.println(F("`3` - Custom"));
  Serial.println(F("`4` - Exit without changing"));
  // SYRINGE_MENU_END
  while (!selected) {
    if(Serial.available()){
      char val = Serial.read();
      switch(val)
      {
      // SYRINGE_CASES_START -- generated/edited by the syringe configurator web app (see /webapp)
      case '1': 
        syringe_div = HAM_7000_5_DIV;
        Serial.println(F("Hamilton 7000.5 0.5uL Selected.\n"));
        selected = true;
        break;
      case '2': 
        syringe_div = HAM_7001_DIV;
        Serial.println(F("Hamilton 7001 1uL Selected.\n"));
        selected = true;
        break;
      case '3':
        syringe_div = get_div();
        Serial.println(F("Custom syringe set.\n"));
        selected = true;
        break;
      case '4':
        Serial.println(F("Syringe not updated.\n"));
        selected = true;
        break;
      // SYRINGE_CASES_END
      }
    }
  }
  restart = true;
}

float get_div() {
  float div;
  Serial.println(F("Input Custom Syringe Volume per Millimeter (nL/mm):")); 
  while (true) {
    if (Serial.available()) {                            
      div = Serial.parseFloat(); 
      if (div < 1 || div > 1000) {
        Serial.println(F("Syringe gradation must be between 1 and 1000 nanoliters per linear millimeter.\nInput value (nL/mm):"));
      } else {break;}
    }
  }
  return div;
}

void printInstructions() {
  Serial.println(F("Input the number associated with a mode to begin: "));
  Serial.println(F("`1` - Extraction Mode"));
  Serial.println(F("`2` - Injection Mode"));
  Serial.println(F("`3` - Manual Joystick Control"));
  Serial.println(F("`4` - Select Syringe"));
  Serial.println();
  Serial.println(F("Press the reset button on the device to exit any mode and see this message again."));
}

void setup() {
  Serial.begin(115200);      
  // SYRINGE_DEFAULT_START -- generated/edited by the syringe configurator web app (see /webapp)
  syringe_div = HAM_7000_5_DIV;
  Serial.println(F("Run keyboard control"));
  Serial.println(F("This Injector is controlled through serial communication."));
  Serial.println(F("Default Syringe: 0.5uL"));
  // SYRINGE_DEFAULT_END
  printInstructions();
  injector.setCurrentPosition(0);
  injector.setMaxSpeed(8000);
}

void loop() {
  injector.setCurrentPosition(0);
  if(restart){
    Serial.println(F("Finished\n"));
    printInstructions();
    restart = false;
  } else if (safety) {
    Serial.println(F("Safety tripped, please extract and reset.\n"));
    printInstructions();
    safety = false;
  }
  if(Serial.available()){
    char val = Serial.read();
    if(val != -1)
    {
      switch(val)
      {
      case '1': 
        start_injector (false);   
        break;
      case '2': 
        start_injector (true);
        break;
      case '3':
        manual();
        break;
      case '4':
        select_syringe();
        break;
      }
    }
    else stop();
  }
}
