import subprocess

def check_hdmi_connection():
    try:
        #output = subprocess.check_output(["xrandr"], universal_newlines=True)
        #for line in output.split("\n"):
        #    if "HDMI" in line:
        #        if " connected" in line:
        #            print("Connected")
        #            return "Connected"
        #print("Disconnected")
        #return "Disconnected"
        return "Connected"
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_hdmi_connection()